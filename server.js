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
    let companyName = "CompanySync";
    let systemPrompt = "";
    let voiceName = "Kore";
    let authenticated = false;

    console.log("📞 New WebSocket connection (waiting for start event...)");

    let geminiWs = null;
    let streamSid = null;
    let isGeminiReady = false;
    let audioBuffer = "";
    let bufferTimeout = null;
    const BUFFER_MS = 100;

    twilioWs.on("message", (raw) => {
        try {
            const msg = JSON.parse(raw);

            switch (msg.event) {
                case "connected":
                    console.log("📞 Twilio connected");
                    break;

                case "start":
                    streamSid = msg.start.streamSid;

                    const params = msg.start.customParameters || {};
                    const secret = params.secret || "";
                    companyName = params.companyName || "CompanySync";
                    systemPrompt = params.systemPrompt || "";
                    voiceName = params.voice || "Kore";

                    if (BRIDGE_SECRET && secret !== BRIDGE_SECRET) {
                        console.error("❌ Invalid secret. Received:", secret ? secret.substring(0, 4) + "..." : "(empty)");
                        twilioWs.close(1008, "Unauthorized");
                        return;
                    }
                    authenticated = true;

                    console.log(`✅ Authenticated | Stream: ${streamSid} | company=${companyName} | voice=${voiceName}`);
                    connectGemini();
                    break;

                case "media":
                    if (!authenticated || !isGeminiReady || !geminiWs || geminiWs.readyState !== WebSocket.OPEN) break;

                    audioBuffer += msg.media.payload;
                    if (!bufferTimeout) {
                        bufferTimeout = setTimeout(() => {
                            if (audioBuffer && geminiWs?.readyState === WebSocket.OPEN) {
                                const pcm = mulawToPcm16k(audioBuffer);
                                geminiWs.send(JSON.stringify({
                                    realtime_input: {
                                        media_chunks: [{ mime_type: "audio/pcm;rate=16000", data: pcm }]
                                    }
                                }));
                            }
                            audioBuffer = "";
                            bufferTimeout = null;
                        }, BUFFER_MS);
                    }
                    break;

                case "stop":
                    console.log("📞 Stream stopped");
                    cleanup();
                    break;
            }
        } catch (e) {
            console.error("❌ Parse error:", e.message);
        }
    });

    twilioWs.on("close", () => {
        console.log("📞 Twilio disconnected");
        cleanup();
    });

    twilioWs.on("error", (e) => console.error("❌ Twilio error:", e.message));

    function cleanup() {
        if (bufferTimeout) clearTimeout(bufferTimeout);
        if (geminiWs) { geminiWs.close(); geminiWs = null; }
        isGeminiReady = false;
    }

    function connectGemini() {
        const geminiUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;
        geminiWs = new WebSocket(geminiUrl);

        geminiWs.on("open", () => {
            console.log("✅ Gemini connected");

            let sysText = systemPrompt || `You are Sarah, a friendly and professional receptionist for ${companyName}.`;
            sysText += `\n\nRULES (VOICE CALL):
- Answer directly in 2-3 sentences max. Be natural and warm.
- Never say you're an AI. You are Sarah, a real person.
- After answering, suggest one logical next step.
- Keep responses SHORT - this is a phone call.`;

            // Setup payload - NO speech_config (not supported by this model)
            const setupPayload = {
                setup: {
                    model: "models/gemini-2.0-flash-exp",
                    generation_config: {
                        response_modalities: ["AUDIO"],
                        speech_config: {
                            voice_config: {
                                prebuilt_voice_config: {
                                    voice_name: voiceName
                                }
                            }
                        }
                    },
                    system_instruction: {
                        parts: [{ text: sysText }]
                    }
                }
            };

            console.log("📤 Sending Gemini setup:", JSON.stringify(setupPayload).substring(0, 200) + "...");
            geminiWs.send(JSON.stringify(setupPayload));
        });

        geminiWs.on("message", (raw) => {
            try {
                const data = JSON.parse(raw);

                if (data.setupComplete) {
                    console.log("✅ Gemini setup complete - LIVE");
                    isGeminiReady = true;

                    geminiWs.send(JSON.stringify({
                        client_content: {
                            turns: [{
                                role: "user",
                                parts: [{ text: `Say exactly this in a warm, friendly tone: "Hi! This is Sarah from ${companyName}. How can I help you today?"` }]
                            }],
                            turn_complete: true
                        }
                    }));
                    return;
                }

                if (data.serverContent?.modelTurn?.parts) {
                    for (const part of data.serverContent.modelTurn.parts) {
                        if (part.inlineData?.mimeType?.startsWith("audio/")) {
                            const mulaw = pcm24kToMulaw8k(part.inlineData.data);
                            if (twilioWs.readyState === WebSocket.OPEN && streamSid) {
                                twilioWs.send(JSON.stringify({
                                    event: "media",
                                    streamSid,
                                    media: { payload: mulaw }
                                }));
                            }
                        }
                        if (part.text) {
                            console.log(`💬 Sarah: ${part.text.substring(0, 80)}`);
                        }
                    }
                }

                if (data.serverContent?.userTurn?.parts) {
                    for (const part of data.serverContent.userTurn.parts) {
                        if (part.text) console.log(`🎤 Caller: "${part.text}"`);
                    }
                }
            } catch (e) {
                console.error("❌ Gemini parse error:", e.message);
            }
        });

        geminiWs.on("close", (code, reason) => {
            console.log(`❌ Gemini closed: ${code} ${reason}`);
            isGeminiReady = false;
        });

        geminiWs.on("error", (e) => {
            console.error("❌ Gemini error:", e.message);
            isGeminiReady = false;
        });
    }
});

server.listen(PORT, () => {
    console.log(`🚀 Sarah Media Stream Bridge running on port ${PORT}`);
});
