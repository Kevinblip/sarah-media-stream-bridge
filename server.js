const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");

const PORT = process.env.PORT || 8080;
const GEMINI_API_KEY = process.env.GOOGLE_GEMINI_API_KEY;
const BRIDGE_SECRET = process.env.SARAH_BRIDGE_SECRET || "";
const BASE44_API_URL = process.env.BASE44_API_URL || "";

if (!GEMINI_API_KEY) {
  console.error("FATAL: GOOGLE_GEMINI_API_KEY is required");
  process.exit(1);
}
if (!BASE44_API_URL) {
  console.warn("WARNING: BASE44_API_URL not set. Tool calls and settings loading will fail.");
  console.warn("Set it to your Base44 sarahBridgeAPI function URL.");
}
if (!BRIDGE_SECRET) {
  console.warn("WARNING: SARAH_BRIDGE_SECRET not set. API calls to Base44 will be unauthenticated.");
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

const BIAS = 0x84;
const CLIP = 32635;

const EXP_LUT = new Uint8Array([
  0, 0, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4,
  4, 4, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
  5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 6, 6, 6, 6, 6, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
]);

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

const LP_COEFFS = new Float64Array([
  0.0595, 0.099, 0.1571, 0.203, 0.2218, 0.203, 0.1571, 0.099, 0.0595,
]);
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
    const sample = Math.max(-32768, Math.min(32767, Math.round(acc)));
    out[i] = mulawEncode(sample);
  }
  return Buffer.from(out).toString("base64");
}

function generateTypingSound() {
  const sampleRate = 8000;
  const durationMs = 800;
  const numSamples = Math.floor((sampleRate * durationMs) / 1000);
  const buffer = new Uint8Array(numSamples);
  buffer.fill(0xff);
  for (let i = 0; i < 4; i++) {
    const pos = Math.floor(Math.random() * (numSamples - 500));
    const clickLen = 100 + Math.floor(Math.random() * 100);
    for (let j = 0; j < clickLen; j++) {
      if (Math.random() > 0.5) buffer[pos + j] = Math.floor(Math.random() * 256);
    }
  }
  return Buffer.from(buffer).toString("base64");
}

const TYPING_SOUND_BASE64 = generateTypingSound();

async function callBase44(action, companyId, data) {
  if (!BASE44_API_URL) {
    console.error("[BASE44] No BASE44_API_URL configured, cannot call:", action);
    return { error: "Base44 API not configured" };
  }

  try {
    const resp = await fetch(BASE44_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${BRIDGE_SECRET}`,
      },
      body: JSON.stringify({
        action,
        companyId,
        data,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error(`[BASE44] ${action} failed: ${resp.status} ${text}`);
      return { error: `Base44 ${action} failed: ${resp.status}` };
    }

    return await resp.json();
  } catch (e) {
    console.error(`[BASE44] ${action} error:`, e.message);
    return { error: e.message };
  }
}

function buildSystemInstruction(settings, companyName, scenario, knowledgeBase, audioContext, interimContext) {
  const agentName = "Sarah";
  const basePrompt =
    settings.system_prompt ||
    `You are ${agentName}, a friendly receptionist for ${companyName}.`;

  if (scenario === "saas_demo") {
    return `
IDENTITY & ROLE:
You are Sarah, the Lead Sales Representative for CompanySync.io.
CompanySync is the "Roof Operating System" - the all-in-one CRM built specifically for roofing contractors.
Your goal is to GET THE ROOFER TO SUBSCRIBE or BOOK A DEMO.

VALUE PROPOSITION:
- All-in-One: Replaces JobNimbus, Acculynx, and ServiceTitan for just $99/month (flat rate).
- AI-Powered: Comes with "Lexi" (AI text assistant) and "Sarah" (YOU - the AI voice receptionist).
- Speed: Sets up in 5 minutes. No 4-week onboarding.
- Features: AI Estimating, Storm Tracking, Mobile App, Automations, Payments.

CONVERSATION FLOW:
1. QUALIFY:
   - "Thanks for calling CompanySync! Are you currently running a roofing business?"
   - "How many crews or sales reps do you have?"
   - "What software are you using right now?"
2. PITCH:
   - If they use JobNimbus/Acculynx: "We replace them for a fraction of the cost, and we include the AI receptionist feature for free."
   - If they use nothing: "CompanySync is perfect for you. It organizes your leads, estimates, and jobs."
3. CLOSE:
   - "I can text you a link to start a free trial right now. Does that sound good?"
   - OR "Do you want to book a quick 15-minute demo?"

OBJECTION HANDLING:
- Is this AI?: "Yes! I am Sarah, the AI receptionist that comes BUILT-IN with CompanySync."
- Price?: "It's $99/month flat. Unlimited users. No hidden fees."

SPECIFIC KNOWLEDGE BASE:
${knowledgeBase || ""}

TOOL PROTOCOLS:
- save_lead_details: Save their Name, Company Name, and Phone immediately.
- book_appointment: Use for booking the DEMO.
- check_availability: Check for demo times.

${audioContext}
${interimContext}
`;
  }

  return `
IDENTITY & ROLE:
${basePrompt}
You are "Sarah", the Senior Office Manager and Intake Specialist for ${companyName}, a premier roofing contractor.
You are NOT a generic AI. You are a roofing industry expert.
Your goal is to BOOK THE FREE INSPECTION.

DOMAIN KNOWLEDGE:
- Hail Damage: "It bruises the shingle mat and voids the manufacturer warranty."
- Wind Damage: "Missing shingles can lead to active leaks and rot if not addressed quickly."
- Insurance: "We specialize in insurance restoration. We work with all major carriers."
- The Process: "Step 1 is a free, no-obligation inspection. We give you a full report."

SPECIFIC KNOWLEDGE BASE:
${knowledgeBase || "No specific knowledge base provided."}

CONVERSATION FLOW:
1. GREETING: "Thanks for calling ${companyName}, this is Sarah. How can I help you with your property today?"
2. DISCOVERY: Assess their situation (leak, quote, inspection).
3. QUALIFICATION: Get property address and name.
4. CLOSE: Book the inspection using check_availability and book_appointment tools.

CORE RULES:
- VOICE-FIRST: Short, punchy sentences (max 20 words). No monologues.
- LEAD THE DANCE: Always end your turn with a question.
- NO FLUFF: Don't repeat "I understand" or "That sounds good."

TOOL PROTOCOLS:
- save_lead_details: CALL THIS IMMEDIATELY once you have a Name, Phone, or Address.
- check_availability: Use when they show interest in an inspection.
- book_appointment: Use after they agree to a specific time.

${audioContext}
${interimContext}
`;
}

const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        service: "sarah-media-stream-bridge",
        base44_configured: !!BASE44_API_URL,
        gemini_configured: !!GEMINI_API_KEY,
      })
    );
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

const wss = new WebSocketServer({ server, path: "/ws/twilio" });

wss.on("connection", async (twilioWs, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const companyId = url.searchParams.get("companyId");
  const scenario = url.searchParams.get("scenario");
  console.log(`[CALL] New connection, companyId=${companyId}, scenario=${scenario}`);

  let geminiWs = null;
  let streamSid = null;

  try {
    let settings = {};
    let companyName = "CompanySync";

    if (companyId && BASE44_API_URL) {
      try {
        const result = await callBase44("getSettings", companyId);
        if (result && !result.error) {
          settings = result.settings || {};
          companyName = result.companyName || "our company";
        }
      } catch (e) {
        console.error("[CALL] Failed to load settings:", e.message);
      }
    }

    const kbParts = [];
    if (settings.website_urls && settings.website_urls.length > 0) {
      kbParts.push(`Company websites: ${settings.website_urls.join(", ")}`);
    }
    if (settings.knowledge_base) kbParts.push(settings.knowledge_base);
    if (settings.custom_responses) {
      kbParts.push(`Custom responses: ${JSON.stringify(settings.custom_responses)}`);
    }
    const knowledgeBase = kbParts.join("\n\n");

    let audioContext = "";
    if (settings.background_audio === "call_center") {
      audioContext =
        "STYLE: You are working in a BUSY CALL CENTER. Speak with a professional, energetic tone.";
    } else if (settings.background_audio === "office") {
      audioContext =
        "STYLE: You are in a quiet professional office. Speak calmly and clearly.";
    }

    let interimContext = "";
    let useTypingSound = false;
    if (settings.interim_audio === "typing") {
      useTypingSound = true;
      interimContext =
        'BEHAVIOR: When you use a tool, say something brief like "Let me type that in..." before you start.';
    } else if (settings.interim_audio === "thinking") {
      interimContext =
        'BEHAVIOR: Use natural fillers like "Hmm, let me see..." when thinking.';
    }

    const systemInstruction = buildSystemInstruction(
      settings,
      companyName,
      scenario,
      knowledgeBase,
      audioContext,
      interimContext
    );

    const selectedVoice =
      VOICE_MAP[settings.voice_id || settings.gemini_voice || ""] ||
      VOICE_MAP["default"];

    console.log(`[CALL] Voice: ${selectedVoice}, Company: ${companyName}`);

    const geminiUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

    geminiWs = new WebSocket(geminiUrl);

    geminiWs.on("open", () => {
      console.log("[GEMINI] Connected");

      const setupMsg = {
        setup: {
          model: "models/gemini-2.5-flash-native-audio-latest",
          generation_config: {
            response_modalities: ["AUDIO"],
            speech_config: {
              voice_config: {
                prebuilt_voice_config: { voice_name: selectedVoice },
              },
            },
          },
          system_instruction: {
            parts: [{ text: systemInstruction }],
          },
          tools: [
            {
              function_declarations: [
                {
                  name: "check_availability",
                  description:
                    "Check available appointment slots for a given date or range.",
                  parameters: {
                    type: "OBJECT",
                    properties: {
                      date_description: {
                        type: "STRING",
                        description: "The date or range to check",
                      },
                    },
                    required: ["date_description"],
                  },
                },
                {
                  name: "book_appointment",
                  description: "Book an appointment slot for the user.",
                  parameters: {
                    type: "OBJECT",
                    properties: {
                      slot_time: {
                        type: "STRING",
                        description: "ISO timestamp of the slot",
                      },
                      name: { type: "STRING", description: "User's name" },
                      email: { type: "STRING", description: "User's email" },
                      phone: {
                        type: "STRING",
                        description: "User's phone number",
                      },
                      description: {
                        type: "STRING",
                        description: "Reason for appointment",
                      },
                    },
                    required: ["slot_time", "name"],
                  },
                },
                {
                  name: "save_lead_details",
                  description: "Save or update lead contact information.",
                  parameters: {
                    type: "OBJECT",
                    properties: {
                      name: { type: "STRING" },
                      email: { type: "STRING" },
                      phone: { type: "STRING" },
                      service_needed: { type: "STRING" },
                      address: { type: "STRING" },
                    },
                  },
                },
              ],
            },
          ],
        },
      };

      geminiWs.send(JSON.stringify(setupMsg));
    });

    geminiWs.on("message", async (rawData) => {
      try {
        const data = JSON.parse(rawData.toString());

        if (data.serverContent?.modelTurn?.parts) {
          for (const part of data.serverContent.modelTurn.parts) {
            if (
              part.inlineData &&
              part.inlineData.mimeType.startsWith("audio/")
            ) {
              const mulawB64 = geminiToTwilio(part.inlineData.data);
              if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
                twilioWs.send(
                  JSON.stringify({
                    event: "media",
                    streamSid: streamSid,
                    media: { payload: mulawB64 },
                  })
                );
              }
            }
          }
        }

        if (data.serverContent?.interrupted) {
          console.log("[GEMINI] Interrupted, clearing Twilio buffer");
          if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
            twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
          }
        }

        if (data.toolCall) {
          console.log("[GEMINI] Tool call:", JSON.stringify(data.toolCall));

          if (
            useTypingSound &&
            streamSid &&
            twilioWs.readyState === WebSocket.OPEN
          ) {
            twilioWs.send(
              JSON.stringify({
                event: "media",
                streamSid: streamSid,
                media: { payload: TYPING_SOUND_BASE64 },
              })
            );
          }

          const toolResponses = [];

          for (const call of data.toolCall.functionCalls) {
            let result = {};
            try {
              if (call.name === "check_availability") {
                result = await callBase44(
                  "checkAvailability",
                  companyId,
                  call.args
                );
              } else if (call.name === "book_appointment") {
                result = await callBase44(
                  "bookAppointment",
                  companyId,
                  call.args
                );
              } else if (call.name === "save_lead_details") {
                result = await callBase44("saveLead", companyId, call.args);
              } else {
                result = { error: `Unknown tool: ${call.name}` };
              }
            } catch (e) {
              console.error(`[TOOL] Error (${call.name}):`, e);
              result = { error: e.message };
            }

            toolResponses.push({
              id: call.id,
              name: call.name,
              response: { result: result },
            });
          }

          geminiWs.send(
            JSON.stringify({
              tool_response: { function_responses: toolResponses },
            })
          );
        }
      } catch (err) {
        console.error("[GEMINI] Message parse error:", err);
      }
    });

    geminiWs.on("close", () => console.log("[GEMINI] Disconnected"));
    geminiWs.on("error", (err) =>
      console.error("[GEMINI] Error:", err.message)
    );
  } catch (error) {
    console.error("[CALL] Setup error:", error);
    twilioWs.close();
    return;
  }

  twilioWs.on("message", (rawMsg) => {
    try {
      const msg = JSON.parse(rawMsg.toString());

      if (msg.event === "start") {
        console.log("[TWILIO] Stream started:", msg.start.streamSid);
        streamSid = msg.start.streamSid;
      }

      if (msg.event === "media" && geminiWs?.readyState === WebSocket.OPEN) {
        const pcmB64 = twilioToGemini(msg.media.payload);
        geminiWs.send(
          JSON.stringify({
            realtime_input: {
              media_chunks: [
                {
                  mime_type: "audio/pcm;rate=16000",
                  data: pcmB64,
                },
              ],
            },
          })
        );
      }

      if (msg.event === "stop") {
        console.log("[TWILIO] Stream stopped");
        geminiWs?.close();
      }
    } catch (err) {
      console.error("[TWILIO] Message error:", err);
    }
  });

  twilioWs.on("close", () => {
    console.log("[TWILIO] Connection closed");
    geminiWs?.close();
  });
});

server.listen(PORT, () => {
  console.log(`Sarah Media Stream Bridge running on port ${PORT}`);
  console.log(`  WebSocket: ws://0.0.0.0:${PORT}/ws/twilio`);
  console.log(`  Health:    http://0.0.0.0:${PORT}/health`);
  console.log(`  Gemini:    ${GEMINI_API_KEY ? "configured" : "MISSING"}`);
  console.log(`  Base44:    ${BASE44_API_URL || "NOT SET"}`);
  console.log(`  Secret:    ${BRIDGE_SECRET ? "set" : "not set"}`);
});
