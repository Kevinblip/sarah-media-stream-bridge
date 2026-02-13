/**
 * Sarah Voice Bridge — Twilio ↔ Gemini Live API
 * Deploy to Railway as server.js
 */

import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';

const PORT = process.env.PORT || 8080;
const GEMINI_API_KEY = process.env.GOOGLE_GEMINI_API_KEY;
const BRIDGE_SECRET  = process.env.SARAH_BRIDGE_SECRET || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash-exp';
const GEMINI_WS_URL =
  `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

// ── ITU G.711 µ-law decode table ──
const MULAW_DECODE_TABLE = new Int16Array(256);
(function buildDecodeTable() {
  for (let i = 0; i < 256; i++) {
    let val = ~i & 0xFF;
    const sign = val & 0x80;
    const exponent = (val >> 4) & 0x07;
    const mantissa = val & 0x0F;
    let magnitude = ((mantissa << 1) + 33) << (exponent + 2);
    magnitude -= 33 * 16;
    MULAW_DECODE_TABLE[i] = sign ? -magnitude : magnitude;
  }
})();

// ── ITU G.711 µ-law encode ──
function mulawEncode(sample) {
  const CLIP  = 32635;
  const BIAS  = 0x84;
  const sign  = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;

  let exponent = 7;
  const expMask = 0x4000;
  for (; exponent > 0; exponent--) {
    if (sample & expMask) break;
    sample <<= 1;
  }
  sample >>= exponent + 3;
  const mantissa = sample & 0x0F;
  return ~(sign | (exponent << 4) | mantissa) & 0xFF;
}

// Twilio mulaw-8kHz → Gemini PCM-16kHz
function twilioToGemini(mulawB64) {
  const src  = Buffer.from(mulawB64, 'base64');
  const nSrc = src.length;

  const pcm8k = new Int16Array(nSrc);
  for (let i = 0; i < nSrc; i++) {
    pcm8k[i] = MULAW_DECODE_TABLE[src[i]];
  }

  const nDst  = nSrc * 2;
  const pcm16 = new Int16Array(nDst);
  for (let i = 0; i < nSrc - 1; i++) {
    pcm16[i * 2]     = pcm8k[i];
    pcm16[i * 2 + 1] = (pcm8k[i] + pcm8k[i + 1]) >> 1;
  }
  pcm16[nDst - 2] = pcm8k[nSrc - 1];
  pcm16[nDst - 1] = pcm8k[nSrc - 1];

  return Buffer.from(pcm16.buffer).toString('base64');
}

// Gemini PCM-24kHz → Twilio mulaw-8kHz
function geminiToTwilio(pcmB64) {
  const buf  = Buffer.from(pcmB64, 'base64');
  const nSrc = buf.length >> 1;

  const nDst = Math.floor(nSrc / 3);
  const out  = Buffer.alloc(nDst);
  for (let i = 0; i < nDst; i++) {
    const sample = buf.readInt16LE(i * 6);
    out[i] = mulawEncode(sample);
  }
  return out.toString('base64');
}

// ── HTTP + WebSocket Server ──

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', ts: Date.now() }));
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Sarah Voice Bridge — Twilio <-> Gemini Live API');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (twilioWs) => {
  console.log('[bridge] Twilio WS connected');

  let streamSid    = null;
  let geminiWs     = null;
  let geminiReady  = false;
  let params       = {};
  const audioQueue = [];
  let keepAliveTimer = null;

  twilioWs.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.event) {
      case 'connected':
        console.log('[twilio] connected event');
        break;

      case 'start':
        streamSid = msg.start.streamSid;
        params    = msg.start.customParameters || {};
        console.log(`[twilio] stream started  sid=${streamSid}  company=${params.companyName || '?'}`);

        if (BRIDGE_SECRET && params.secret !== BRIDGE_SECRET) {
          console.error('[bridge] bad secret – closing');
          twilioWs.close();
          return;
        }

        openGemini(params);
        break;

      case 'media':
        if (geminiReady && geminiWs?.readyState === WebSocket.OPEN) {
          sendAudioToGemini(msg.media.payload);
        } else {
          audioQueue.push(msg.media.payload);
          if (audioQueue.length > 200) audioQueue.shift();
        }
        break;

      case 'mark':
        break;

      case 'stop':
        console.log('[twilio] stream stopped');
        cleanup();
        break;

      default: break;
    }
  });

  twilioWs.on('close', () => { console.log('[twilio] WS closed'); cleanup(); });
  twilioWs.on('error', (e) => { console.error('[twilio] WS error:', e.message); });

  function sendAudioToGemini(mulawB64) {
    const pcmB64 = twilioToGemini(mulawB64);
    geminiWs.send(JSON.stringify({
      realtimeInput: {
        mediaChunks: [{ mimeType: 'audio/pcm;rate=16000', data: pcmB64 }]
      }
    }));
  }

  function sendAudioToTwilio(pcmB64) {
    if (twilioWs.readyState !== WebSocket.OPEN || !streamSid) return;
    const mulawB64 = geminiToTwilio(pcmB64);
    twilioWs.send(JSON.stringify({
      event: 'media',
      streamSid,
      media: { payload: mulawB64 }
    }));
  }

  function cleanup() {
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    if (geminiWs && geminiWs.readyState === WebSocket.OPEN) geminiWs.close();
    geminiReady = false;
  }

  function openGemini(p) {
    const systemPrompt = p.systemPrompt || 'You are Sarah, a friendly and professional receptionist.';
    const voiceName    = p.voice        || 'Aoede';

    console.log(`[gemini] connecting  model=${GEMINI_MODEL}  voice=${voiceName}`);
    geminiWs = new WebSocket(GEMINI_WS_URL);

    geminiWs.on('open', () => {
      console.log('[gemini] WS open – sending setup');

      geminiWs.send(JSON.stringify({
        setup: {
          model: `models/${GEMINI_MODEL}`,
          generation_config: {
            response_modalities: ['AUDIO'],
            speech_config: {
              voice_config: {
                prebuilt_voice_config: { voice_name: voiceName }
              }
            }
          },
          system_instruction: {
            parts: [{ text: systemPrompt }]
          }
        }
      }));
    });

    geminiWs.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      // Setup complete
      if (msg.setupComplete) {
        console.log('[gemini] setup complete');
        geminiReady = true;

        // Flush buffered audio
        while (audioQueue.length > 0) {
          sendAudioToGemini(audioQueue.shift());
        }

        // Gemini does NOT auto-greet — send initial prompt
        geminiWs.send(JSON.stringify({
          clientContent: {
            turns: [{
              role: 'user',
              parts: [{ text: 'Hello, I just called in. Please greet me warmly and ask how you can help.' }]
            }],
            turnComplete: true
          }
        }));

        // Keep-alive: send silence every 15s to prevent timeout
        keepAliveTimer = setInterval(() => {
          if (!geminiReady || geminiWs?.readyState !== WebSocket.OPEN) return;
          const silence = Buffer.alloc(320); // 160 samples × 2 bytes = 10ms of silence
          geminiWs.send(JSON.stringify({
            realtimeInput: {
              mediaChunks: [{ mimeType: 'audio/pcm;rate=16000', data: silence.toString('base64') }]
            }
          }));
        }, 15_000);

        return;
      }

      // Audio from Gemini → Twilio
      if (msg.serverContent?.modelTurn?.parts) {
        for (const part of msg.serverContent.modelTurn.parts) {
          if (part.inlineData?.mimeType?.startsWith('audio/')) {
            sendAudioToTwilio(part.inlineData.data);
          }
          if (part.text) {
            console.log(`[gemini] text: ${part.text.substring(0, 120)}`);
          }
        }
      }

      // Turn complete
      if (msg.serverContent?.turnComplete) {
        console.log('[gemini] turn complete');
        if (twilioWs.readyState === WebSocket.OPEN && streamSid) {
          twilioWs.send(JSON.stringify({
            event: 'mark',
            streamSid,
            mark: { name: `turn_${Date.now()}` }
          }));
        }
      }

      // Interruption
      if (msg.serverContent?.interrupted) {
        console.log('[gemini] interrupted');
        if (twilioWs.readyState === WebSocket.OPEN && streamSid) {
          twilioWs.send(JSON.stringify({ event: 'clear', streamSid }));
        }
      }
    });

    geminiWs.on('close', (code, reason) => {
      console.log(`[gemini] WS closed  code=${code}  reason=${reason || ''}`);
      geminiReady = false;
    });

    geminiWs.on('error', (err) => {
      console.error('[gemini] WS error:', err.message);
      geminiReady = false;
    });
  }
});

server.listen(PORT, () => {
  console.log(`\n🚀  Sarah Voice Bridge listening on :${PORT}`);
  console.log(`    model     = ${GEMINI_MODEL}`);
  console.log(`    apiKey    = ${GEMINI_API_KEY ? '✅' : '❌ MISSING'}`);
  console.log(`    secret    = ${BRIDGE_SECRET ? '✅' : '⚠️  not set'}\n`);
});
And the package.json:

{
  "name": "sarah-voice-bridge",
  "version": "1.0.0",
  "type": "module",
  "main": "server.js",
  "scripts": { "start": "node server.js" },
  "dependencies": { "ws": "^8.18.0" }
}
