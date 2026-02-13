const { WebSocketServer, WebSocket } = require("ws");
const http = require("http");

const PORT = process.env.PORT || 8080;
const GEMINI_API_KEY = process.env.GOOGLE_GEMINI_API_KEY;
const BRIDGE_SECRET = process.env.SARAH_BRIDGE_SECRET;

// ─── Audio Conversion ───

function mulawToPcm16k(mulawBase64) {
    const mulawBytes = Buffer.from(mulawBase64, "base64");
    const MULAW_BIAS = 33;
    const pcm8k = new Int16Array(mulawBytes.length);

    for (let i = 0; i < mulawBytes.length; i++) {
        let mulaw = ~mulawBytes[i] & 0xff;
        const sign = mulaw & 0x80 ? -1 : 1;
        mulaw = mulaw & 0x7f;
        const exponent = (mulaw >> 4) & 0x07;
        const mantissa = mulaw & 0x0f;
        let sample;
        if (exponent === 0) {
            sample = (mantissa * 2 + 1) * MULAW_BIAS / 2;
        } else {
            sample = ((1 << exponent) * (mantissa * 2 + 33)) - MULAW_BIAS;
        }
        pcm8k[i] = sign * Math.min(sample, 32767);
    }

    const pcm16k = new Int16Array(pcm8k.length * 2);
    for (let i = 0; i < pcm8k.length - 1; i++) {
        pcm16k[i * 2] = pcm8k[i];
        pcm16k[i * 2 + 1] = Math.round((pcm8k[i] + pcm8k[i + 1]) / 2);
    }
    pcm16k[(pcm8k.length - 1) * 2] = pcm8k[pcm8k.length - 1];
    pcm16k[(pcm8k.length - 1) * 2 + 1] = pcm8k[pcm8k.length - 1];

    return Buffer.from(pcm16k.buffer).toString("base64");
}

function pcm24kToMulaw8k(pcmBase64) {
    const buf = Buffer.from(pcmBase64, "base64");
    const pcm24k = new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2);

    const pcm8k = new Int16Array(Math.floor(pcm24k.length / 3));
    for (let i = 0; i < pcm8k.length; i++) {
        pcm8k[i] = pcm24k[i * 3];
    }

    const MULAW_MAX = 0x1fff;
    const MULAW_BIAS = 33;
    const mulawBytes = Buffer.alloc(pcm8k.length);

    for (let i = 0; i < pcm8k.length; i++) {
        let sample = pcm8k[i];
        const sign = sample < 0 ? 0x80 : 0;
        if (sample < 0) sample = -sample;
        sample = Math.min(sample, MULAW_MAX);
        sample += MULAW_BIAS;

        let exponent = 7;
        const expMask = 0x4000;
        for (; exponent > 0; exponent--) {
            if (sample & (expMask >> (7 - exponent))) break;
        }

        const mantissa = (sample >> (exponent + 3)) & 0x0f;
        mulawBytes[i] = ~(sign | (exponent << 4) | mantissa) & 0xff;
    }

    return mulawBytes.toString("base64");
}

// ─── Server ───

const server = http.createServer((req, res) => {
    if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", service: "sarah-media-stream-bridge" }));
        return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Sarah Media Stream Bridge");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (twilioWs, req) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const secret = url.searchParams.get("secret");
    const companyName = decodeURIComponent(url.searchParams.get("companyName") || "CompanySync");
