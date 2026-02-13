const WebSocket = require('ws');
const http = require('http');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const BRIDGE_SECRET = process.env.SARAH_BRIDGE_SECRET || '';
const PORT = process.env.PORT || 8080;

// Gemini Live API model
const GEMINI_MODEL = 'gemini-2.0-flash-live-001';
const GEMINI_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', model: GEMINI_MODEL }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Sarah Media Stream Bridge - Railway');
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (twilioWs, req) => {
  console.log('🔌 New Twilio WebSocket connection');

  let geminiWs = null;
  let streamSid = null;
  let callSid = null;
  let systemPrompt = '';
  let voiceName = 'Kore';
  let companyName = '';
  let setupComplete = false;

  twilioWs.on('message', (data) => {
    try {
      const msg = JSON.parse(data);

      switch (msg.event) {
        case 'connected':
          console.log('📞 Twilio connected');
          break;

        case 'start':
          streamSid = msg.start.streamSid;
          callSid = msg.start.callSid;

          // Extract parameters sent via TwiML <Parameter>
          const params = msg.start.customParameters || {};
          systemPrompt = params.systemPrompt || 'You are Sarah, a friendly receptionist.';
          voiceName = params.voice || 'Kore';
          companyName = params.companyName || '';

          console.log(`📞 Stream started | SID: ${streamSid} | Company: ${companyName} | Voice: ${voiceName}`);

          // Validate secret if configured
          if (BRIDGE_SECRET && params.secret !== BRIDGE_SECRET) {
            console.error('❌ Invalid bridge secret, closing connection');
            twilioWs.close();
            return;
          }

          // Connect to Gemini Live API
          connectToGemini();
          break;

        case 'media':
          // Forward Twilio audio to Gemini
          if (geminiWs && geminiWs.readyState === WebSocket.OPEN && setupComplete) {
            const audioData = msg.media.payload; // base64 mulaw 8kHz

            // Send raw audio to Gemini - it handles mulaw natively
            const realtimeInput = {
              realtimeInput: {
                mediaChunks: [{
                  mimeType: 'audio/pcm;rate=8000',
                  data: audioData
                }]
              }
            };

            geminiWs.send(JSON.stringify(realtimeInput));
          }
          break;

        case 'stop':
          console.log('📞 Twilio stream stopped');
          cleanup();
          break;

        default:
          break;
      }
    } catch (err) {
      console.error('❌ Error processing Twilio message:', err.message);
    }
  });

  twilioWs.on('close', () => {
    console.log('📞 Twilio WebSocket closed');
    cleanup();
  });

  twilioWs.on('error', (err) => {
    console.error('❌ Twilio WebSocket error:', err.message);
    cleanup();
  });

  function connectToGemini() {
    console.log(`🤖 Connecting to Gemini Live API (${GEMINI_MODEL})...`);

    geminiWs = new WebSocket(GEMINI_WS_URL);

    geminiWs.on('open', () => {
      console.log('✅ Gemini WebSocket connected');

      // Send setup message
      const setupMsg = {
        setup: {
          model: `models/${GEMINI_MODEL}`,
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: voiceName
                }
              }
            }
          },
          systemInstruction: {
            parts: [{
              text: systemPrompt
            }]
          }
        }
      };

      geminiWs.send(JSON.stringify(setupMsg));
      console.log('📤 Setup message sent to Gemini');
    });

    geminiWs.on('message', (data) => {
      try {
        const response = JSON.parse(data.toString());

        // Handle setup completion
        if (response.setupComplete) {
          setupComplete = true;
          console.log('✅ Gemini setup complete - ready for audio');
          return;
        }

        // Handle audio response from Gemini
        if (response.serverContent?.modelTurn?.parts) {
          for (const part of response.serverContent.modelTurn.parts) {
            if (part.inlineData?.mimeType?.startsWith('audio/') && part.inlineData.data) {
              // Send audio back to Twilio
              if (twilioWs.readyState === WebSocket.OPEN && streamSid) {
                const mediaMsg = {
                  event: 'media',
                  streamSid: streamSid,
                  media: {
                    payload: part.inlineData.data // base64 audio
                  }
                };
                twilioWs.send(JSON.stringify(mediaMsg));
              }
            }

            // Log any text parts (for debugging)
            if (part.text) {
              console.log(`💬 Gemini text: ${part.text.substring(0, 100)}`);
            }
          }
        }

        // Handle turn completion
        if (response.serverContent?.turnComplete) {
          console.log('🔄 Gemini turn complete');
        }

      } catch (err) {
        console.error('❌ Error processing Gemini message:', err.message);
      }
    });

    geminiWs.on('close', (code, reason) => {
      console.log(`🤖 Gemini WebSocket closed: ${code} ${reason}`);
      setupComplete = false;
    });

    geminiWs.on('error', (err) => {
      console.error('❌ Gemini WebSocket error:', err.message);
      setupComplete = false;
    });
  }

  function cleanup() {
    if (geminiWs) {
      try {
        geminiWs.close();
      } catch (e) {}
      geminiWs = null;
    }
    setupComplete = false;
  }
});

server.listen(PORT, () => {
  console.log(`🚀 Sarah Media Stream Bridge running on port ${PORT}`);
  console.log(`🤖 Using Gemini model: ${GEMINI_MODEL}`);
  console.log(`🔐 Bridge secret: ${BRIDGE_SECRET ? 'configured' : 'NOT SET'}`);
});
