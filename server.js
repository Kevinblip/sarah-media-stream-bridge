/**
 * Sarah Voice Bridge — Twilio ↔ Gemini Live API
 * Deploy to Railway as server.js
 */

const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;
const GEMINI_API_KEY = process.env.GOOGLE_GEMINI_API_KEY;
const BRIDGE_SECRET  = process.env.SARAH_BRIDGE_SECRET || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash-exp';
const GEMINI_WS_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=' + GEMINI_API_KEY;

// ITU G.711 mu-law decode table
const MULAW_DECODE_TABLE = new Int16Array(256);
(function buildDecodeTable() {
  for (var i = 0; i < 256; i++) {
    var val = ~i & 0xFF;
    var sign = val & 0x80;
    var exponent = (val >> 4) & 0x07;
    var mantissa = val & 0x0F;
    var magnitude = ((mantissa << 1) + 33) << (exponent + 2);
    magnitude -= 33 * 16;
    MULAW_DECODE_TABLE[i] = sign ? -magnitude : magnitude;
  }
})();

// ITU G.711 mu-law encode
function mulawEncode(sample) {
  var CLIP = 32635;
  var BIAS = 0x84;
  var sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;

  var exponent = 7;
  var expMask = 0x4000;
  for (; exponent > 0; exponent--) {
    if (sample & expMask) break;
    sample <<= 1;
  }
  sample >>= exponent + 3;
  var mantissa = sample & 0x0F;
  return ~(sign | (exponent << 4) | mantissa) & 0xFF;
}

// Twilio mulaw-8kHz -> Gemini PCM-16kHz
function twilioToGemini(mulawB64) {
  var src = Buffer.from(mulawB64, 'base64');
  var nSrc = src.length;

  var pcm8k = new Int16Array(nSrc);
  for (var i = 0; i < nSrc; i++) {
    pcm8k[i] = MULAW_DECODE_TABLE[src[i]];
  }

  var nDst = nSrc * 2;
  var pcm16 = new Int16Array(nDst);
  for (var i = 0; i < nSrc - 1; i++) {
    pcm16[i * 2] = pcm8k[i];
    pcm16[i * 2 + 1] = (pcm8k[i] + pcm8k[i + 1]) >> 1;
  }
  pcm16[nDst - 2] = pcm8k[nSrc - 1];
  pcm16[nDst - 1] = pcm8k[nSrc - 1];

  return Buffer.from(pcm16.buffer).toString('base64');
}

// Gemini PCM-24kHz -> Twilio mulaw-8kHz
function geminiToTwilio(pcmB64) {
  var buf = Buffer.from(pcmB64, 'base64');
  var nSrc = buf.length >> 1;

  var nDst = Math.floor(nSrc / 3);
  var out = Buffer.alloc(nDst);
  for (var i = 0; i < nDst; i++) {
    var sample = buf.readInt16LE(i * 6);
    out[i] = mulawEncode(sample);
  }
  return out.toString('base64');
}

// HTTP + WebSocket Server
var server = http.createServer(function(req, res) {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', ts: Date.now() }));
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Sarah Voice Bridge - Twilio <-> Gemini Live API');
});

var wss = new WebSocketServer({ server: server });

wss.on('connection', function(twilioWs) {
  console.log('[bridge] Twilio WS connected');

  var streamSid = null;
  var geminiWs = null;
  var geminiReady = false;
  var params = {};
  var audioQueue = [];
  var keepAliveTimer = null;

  twilioWs.on('message', function(raw) {
    var msg;
    try { msg = JSON.parse(raw.toString()); } catch(e) { return; }

    switch (msg.event) {
      case 'connected':
        console.log('[twilio] connected event');
        break;

      case 'start':
        streamSid = msg.start.streamSid;
        params = msg.start.customParameters || {};
        console.log('[twilio] stream started  sid=' + streamSid + '  company=' + (params.companyName || '?'));

        if (BRIDGE_SECRET && params.secret !== BRIDGE_SECRET) {
          console.error('[bridge] bad secret - closing');
          twilioWs.close();
          return;
        }

        openGemini(params);
        break;

      case 'media':
        if (geminiReady && geminiWs && geminiWs.readyState === WebSocket.OPEN) {
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

  twilioWs.on('close', function() { console.log('[twilio] WS closed'); cleanup(); });
  twilioWs.on('error', function(e) { console.error('[twilio] WS error:', e.message); });

  function sendAudioToGemini(mulawB64) {
    var pcmB64 = twilioToGemini(mulawB64);
    geminiWs.send(JSON.stringify({
      realtimeInput: {
        mediaChunks: [{ mimeType: 'audio/pcm;rate=16000', data: pcmB64 }]
      }
    }));
  }

  function sendAudioToTwilio(pcmB64) {
    if (twilioWs.readyState !== WebSocket.OPEN || !streamSid) return;
    var mulawB64 = geminiToTwilio(pcmB64);
    twilioWs.send(JSON.stringify({
      event: 'media',
      streamSid: streamSid,
      media: { payload: mulawB64 }
    }));
  }

  function cleanup() {
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    if (geminiWs && geminiWs.readyState === WebSocket.OPEN) geminiWs.close();
    geminiReady = false;
  }

  function openGemini(p) {
    var systemPrompt = p.systemPrompt || 'You are Sarah, a friendly and professional receptionist.';
    var voiceName = p.voice || 'Aoede';

    console.log('[gemini] connecting  model=' + GEMINI_MODEL + '  voice=' + voiceName);
    geminiWs = new WebSocket(GEMINI_WS_URL);

    geminiWs.on('open', function() {
      console.log('[gemini] WS open - sending setup');

      geminiWs.send(JSON.stringify({
        setup: {
          model: 'models/' + GEMINI_MODEL,
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

    geminiWs.on('message', function(raw) {
      var msg;
      try { msg = JSON.parse(raw.toString()); } catch(e) { return; }

      if (msg.setupComplete) {
        console.log('[gemini] setup complete');
        geminiReady = true;

        while (audioQueue.length > 0) {
          sendAudioToGemini(audioQueue.shift());
        }

        // Gemini does NOT auto-greet - send initial prompt
        geminiWs.send(JSON.stringify({
          clientContent: {
            turns: [{
              role: 'user',
              parts: [{ text: 'Hello, I just called in. Please greet me warmly and ask how you can help.' }]
            }],
            turnComplete: true
          }
        }));

        // Keep-alive silence every 15s
        keepAliveTimer = setInterval(function() {
          if (!geminiReady || !geminiWs || geminiWs.readyState !== WebSocket.OPEN) return;
          var silence = Buffer.alloc(320);
          geminiWs.send(JSON.stringify({
            realtimeInput: {
              mediaChunks: [{ mimeType: 'audio/pcm;rate=16000', data: silence.toString('base64') }]
            }
          }));
        }, 15000);

        return;
      }

      if (msg.serverContent && msg.serverContent.modelTurn && msg.serverContent.modelTurn.parts) {
        var parts = msg.serverContent.modelTurn.parts;
        for (var i = 0; i < parts.length; i++) {
          var part = parts[i];
          if (part.inlineData && part.inlineData.mimeType && part.inlineData.mimeType.indexOf('audio/') === 0) {
            sendAudioToTwilio(part.inlineData.data);
          }
          if (part.text) {
            console.log('[gemini] text: ' + part.text.substring(0, 120));
          }
        }
      }

      if (msg.serverContent && msg.serverContent.turnComplete) {
        console.log('[gemini] turn complete');
        if (twilioWs.readyState === WebSocket.OPEN && streamSid) {
          twilioWs.send(JSON.stringify({
            event: 'mark',
            streamSid: streamSid,
            mark: { name: 'turn_' + Date.now() }
          }));
        }
      }

      if (msg.serverContent && msg.serverContent.interrupted) {
        console.log('[gemini] interrupted');
        if (twilioWs.readyState === WebSocket.OPEN && streamSid) {
          twilioWs.send(JSON.stringify({ event: 'clear', streamSid: streamSid }));
        }
      }
    });

    geminiWs.on('close', function(code, reason) {
      console.log('[gemini] WS closed  code=' + code + '  reason=' + (reason || ''));
      geminiReady = false;
    });

    geminiWs.on('error', function(err) {
      console.error('[gemini] WS error:', err.message);
      geminiReady = false;
    });
  }
});

server.listen(PORT, function() {
  console.log('');
  console.log('Sarah Voice Bridge listening on :' + PORT);
  console.log('  model   = ' + GEMINI_MODEL);
  console.log('  apiKey  = ' + (GEMINI_API_KEY ? 'SET' : 'MISSING'));
  console.log('  secret  = ' + (BRIDGE_SECRET ? 'SET' : 'not set'));
  console.log('');
});
