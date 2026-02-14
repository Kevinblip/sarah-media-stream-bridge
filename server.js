const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");

const PORT = process.env.PORT || 8080;
const GEMINI_API_KEY = process.env.GOOGLE_GEMINI_API_KEY;
const BASE44_API_URL = process.env.BASE44_API_URL;
const SARAH_BRIDGE_SECRET = process.env.SARAH_BRIDGE_SECRET;

if (!GEMINI_API_KEY) {
  console.error("FATAL: GOOGLE_GEMINI_API_KEY is required");
  process.exit(1);
}

if (!BASE44_API_URL) {
  console.warn("WARNING: BASE44_API_URL missing. Tool calls to Base44 will fail.");
}

const VOICE_MAP = {
  Puck: "Puck",
  Charon: "Charon",
  Kore: "Kore",
  Fenrir: "Fenrir",
  Aoede: "Aoede",
  Sage: "Sage",
  Orion: "Orion",
  default: "Kore",
};

// --- Audio Utilities ---
const BIAS = 0x84;
const CLIP = 32635;
const EXP_LUT = new Uint8Array([0, 0, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7]);

function mulawEncode(sample) {
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  const exponent = EXP_LUT[(sample >> 7) & 0xff];
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

const MULAW_DECODE_TABLE = new Int16Array(256);
(function buildDecodeTable() {
  for (let i = 0; i < 256; i++) {
    const val = ~i & 0xff;
    const sign = val & 0x80;
    const exponent = (val >> 4) & 0x07;
    const mantissa = val & 0x0f;
    let magnitude = ((mantissa << 3) + BIAS) << exponent;
    magnitude -= BIAS;
    MULAW_DECODE_TABLE[i] = sign ? -magnitude : magnitude;
  }
})();

function twilioToGemini(mulawB64) {
  const raw = Buffer.from(mulawB64, "base64");
  const nSrc = raw.length;
  const pcm8k = new Int16Array(nSrc);
  for (let i = 0; i < nSrc; i++) {
    pcm8k[i] = MULAW_DECODE_TABLE[raw[i]];
  }
  const nDst = nSrc * 2;
  const pcm16 = new Int16Array(nDst);
  for (let i = 0; i < nSrc - 1; i++) {
    pcm16[i * 2] = pcm8k[i];
    pcm16[i * 2 + 1] = (pcm8k[i] + pcm8k[i + 1]) >> 1;
  }
  pcm16[nDst - 2] = pcm8k[nSrc - 1];
  pcm16[nDst - 1] = pcm8k[nSrc - 1];
  return Buffer.from(pcm16.buffer).toString("base64");
}

const LP_COEFFS = new Float64Array([0.0595, 0.099, 0.1571, 0.203, 0.2218, 0.203, 0.1571, 0.099, 0.0595]);
const LP_LEN = LP_COEFFS.length;
const LP_HALF = (LP_LEN - 1) >> 1;

function geminiToTwilio(pcmB64) {
  const raw = Buffer.from(pcmB64, "base64");
  const nSrc = raw.length >> 1;
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const pcm = new Float64Array(nSrc);
  for (let i = 0; i < nSrc; i++) pcm[i] = view.getInt16(i * 2, true);
  let prev = pcm[0];
  for (let i = 1; i < nSrc; i++) {
    const orig = pcm[i];
    pcm[i] = orig - 0.4 * prev;
    prev = orig;
  }
  const ratio = 3;
  const nDst = Math.floor(nSrc / ratio);
  const out = new Uint8Array(nDst);
  for (let i = 0; i < nDst; i++) {
    const center = i * ratio;
    let acc = 0;
    for (let k = 0; k < LP_LEN; k++) {
      const idx = center - LP_HALF + k;
      if (idx >= 0 && idx < nSrc) acc += pcm[idx] * LP_COEFFS[k];
    }
    const sample = Math.max(-
