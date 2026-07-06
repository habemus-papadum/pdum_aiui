/**
 * RT0 spike (July 2026) — Gemini Live as the realtime-submode composer.
 * Run: node archive/gemini-live-spike.mjs   (needs GEMINI_API_KEY in .env.dev,
 * `npm i @google/genai` NOT needed — raw WebSocket; hello.pcm from
 * https://storage.googleapis.com/generativeai-downloads/data/hello_are_you_there.pcm)
 *
 * FINDINGS (all verified live against gemini-3.1-flash-live-preview):
 *  1. @google/genai 2.10.0 SILENTLY DROPS realtimeInputConfig from the setup
 *     frame (in the .d.ts, absent from the wire transformer) — manual VAD via
 *     the SDK is impossible; activity signals then hit "Precondition check
 *     failed" (1007). Hence RAW WebSocket (BidiGenerateContent, v1beta), which
 *     also matches how the channel speaks to OpenAI realtime.
 *  2. Manual VAD (automaticActivityDetection.disabled) gives FULL turn
 *     control: the model stayed silent through a 2s mid-window pause (the
 *     drag-selection case) and responded only after activityEnd.
 *  3. UNDOCUMENTED window rule: a manual activity window must OPEN WITH
 *     AUDIO. text-first in a window → 1007; after audio, text and video
 *     frames interleave freely. (Natural fit: the mic streams continuously.)
 *  4. Bare realtimeInput.text OUTSIDE a window is a legal immediate turn —
 *     the "Enter nudge" mechanism works.
 *  5. Labeled-image correlation works: send `[image s1]` as text + the frame
 *     as realtimeInput.video (PNG ok); the model cites ids in speech AND
 *     returns them in the function call. Metadata never sent to the model.
 *  6. submit_intent returns the interleaved segments shape natively:
 *     [{text}, {image:"s1"}, {text}, {image:"s2"}, {text}].
 *  7. usageMetadata arrives per turn (AUDIO token breakdown) → cost.ts ready.
 */
/**
 * RT0 spike, raw-WebSocket edition (the @google/genai 2.10.0 transformer drops
 * realtimeInputConfig from the setup frame — types promise it, wire never sees
 * it — so we speak BidiGenerateContent directly, which is also how the channel
 * will do it, mirroring the OpenAI realtime socket).
 */
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const envFile = readFileSync("/Users/nehal/src/pdum_aiui/.env.dev", "utf8");
const key = envFile
  .match(/^GEMINI_API_KEY=(.*)$/m)?.[1]
  ?.trim()
  .replace(/^['"]|['"]$/g, "");

// ── tiny PNG encoder (solid color) ───────────────────────────────────────────
function crc32(buf) {
  let c,
    crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function solidPng(w, h, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3)]);
  for (let x = 0; x < w; x++) {
    row[1 + x * 3] = r;
    row[2 + x * 3] = g;
    row[3 + x * 3] = b;
  }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const redPng = solidPng(96, 96, [220, 30, 30]).toString("base64");
const bluePng = solidPng(96, 96, [30, 60, 220]).toString("base64");

// ── raw session ──────────────────────────────────────────────────────────────
const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${key}`;
const ws = new WebSocket(url);
const queue = [];
let closedReason = null;
ws.addEventListener("close", (e) => {
  closedReason = `${e.code} ${e.reason}`;
  console.log("· closed:", closedReason);
});
ws.addEventListener("error", () => console.log("! ws error"));
ws.addEventListener("message", async (e) => {
  const text =
    typeof e.data === "string"
      ? e.data
      : Buffer.from((await e.data.arrayBuffer?.()) ?? e.data).toString("utf8");
  queue.push(JSON.parse(text));
});
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve);
  ws.addEventListener("error", reject);
});
console.log("· connected (raw ws)");

const send = (obj) => ws.send(JSON.stringify(obj));
send({
  setup: {
    model: "models/gemini-3.1-flash-live-preview",
    generationConfig: { responseModalities: ["AUDIO"] },
    systemInstruction: {
      parts: [
        {
          text:
            "You help a developer compose a request for a coding agent while they talk and share " +
            "images of their app. Images arrive labeled with bracketed ids like [image s1]. When the " +
            "user asks you to submit, call submit_intent: segments[] interleaves the cleaned-up " +
            'request text with image refs (bare id, e.g. "s1") placed where each image belongs. ' +
            "Speak briefly otherwise.",
        },
      ],
    },
    tools: [
      {
        functionDeclarations: [
          {
            name: "submit_intent",
            description:
              "Deliver the composed request to the coding agent as interleaved segments.",
            parameters: {
              type: "OBJECT",
              properties: {
                segments: {
                  type: "ARRAY",
                  items: {
                    type: "OBJECT",
                    properties: { text: { type: "STRING" }, image: { type: "STRING" } },
                  },
                },
              },
              required: ["segments"],
            },
          },
        ],
      },
    ],
    realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  },
});

const next = async (pred, ms) => {
  const t0 = Date.now();
  for (;;) {
    const i = queue.findIndex(pred);
    if (i >= 0) return queue.splice(i, 1)[0];
    if (closedReason) return null;
    if (Date.now() - t0 > ms) return null;
    await new Promise((r) => setTimeout(r, 50));
  }
};
console.log("· setupComplete:", !!(await next((m) => m.setupComplete, 10_000)));

// ── phase 1: labeled images + instruction, one manual activity window ────────
let sawEarlyTurn = false;
send({ realtimeInput: { activityStart: {} } });
// A manual activity window must OPEN with audio (bisect finding: text-first →
// 1007 Precondition failed; audio-first, then text/video interleave freely).
// In the real modality the mic is always streaming, so this is natural.
send({
  realtimeInput: {
    audio: { data: readFileSync("hello.pcm").toString("base64"), mimeType: "audio/pcm;rate=16000" },
  },
});
send({ realtimeInput: { text: "I'm sharing two screenshots of my dashboard." } });
send({ realtimeInput: { text: "[image s1]" } });
send({ realtimeInput: { video: { data: redPng, mimeType: "image/png" } } });
send({ realtimeInput: { text: "[image s2]" } });
send({ realtimeInput: { video: { data: bluePng, mimeType: "image/png" } } });
send({
  realtimeInput: {
    text:
      "Make the panel in the RED screenshot twice as wide, and give the chart in the BLUE " +
      "screenshot a taller y-axis. Submit this now: call submit_intent, interleaving the text " +
      "with the right image ids.",
  },
});
await new Promise((r) => setTimeout(r, 2000)); // a "drag" of silence mid-turn
sawEarlyTurn = queue.some((m) => m.serverContent?.modelTurn || m.toolCall);
console.log(
  "· 2s mid-activity silence:",
  sawEarlyTurn ? "MODEL ACTED EARLY ✗" : "model stayed quiet ✓",
);
const endAt = Date.now();
send({ realtimeInput: { activityEnd: {} } });

let toolMsg = await next((m) => m.toolCall, 20_000);
if (!toolMsg) {
  // The model chose to talk instead (a clarifying question). The Enter-nudge:
  // bare text OUTSIDE any activity window is a legal, immediate turn (bisect:
  // "text-outside" works) — tell it to submit unconditionally.
  await next((m) => m.serverContent?.turnComplete, 15_000);
  console.log("· no toolCall yet — sending the Enter nudge");
  send({
    realtimeInput: {
      text: "Yes, exactly that. Submit now — call submit_intent immediately, no further questions.",
    },
  });
  toolMsg = await next((m) => m.toolCall, 20_000);
}
if (toolMsg) {
  const fc = toolMsg.toolCall.functionCalls?.[0];
  console.log(`· toolCall ${fc.name} (+${Date.now() - endAt}ms):`);
  console.log(JSON.stringify(fc.args, null, 1));
  send({
    toolResponse: { functionResponses: [{ id: fc.id, name: fc.name, response: { ok: true } }] },
  });
} else {
  console.log("✗ no toolCall (closed:", closedReason, ")");
}
await next((m) => m.serverContent?.turnComplete, 15_000);

// ── phase 2: real PCM audio in a manual window ───────────────────────────────
const pcm = readFileSync("hello.pcm").toString("base64");
send({ realtimeInput: { activityStart: {} } });
send({ realtimeInput: { audio: { data: pcm, mimeType: "audio/pcm;rate=16000" } } });
send({ realtimeInput: { activityEnd: {} } });
let inTx = "",
  outTx = "",
  audioBytes = 0,
  usage = null;
const t0 = Date.now();
while (Date.now() - t0 < 20_000 && !closedReason) {
  const m = await next(() => true, 1000);
  if (!m) continue;
  const sc = m.serverContent;
  if (sc?.inputTranscription?.text) inTx += sc.inputTranscription.text;
  if (sc?.outputTranscription?.text) outTx += sc.outputTranscription.text;
  for (const p of sc?.modelTurn?.parts ?? [])
    if (p.inlineData?.data) audioBytes += Buffer.from(p.inlineData.data, "base64").length;
  if (m.usageMetadata) usage = m.usageMetadata;
  if (sc?.turnComplete) break;
}
console.log(`· phase2 heard: "${inTx.trim()}"`);
console.log(`· phase2 model said: "${outTx.trim().slice(0, 120)}"`);
console.log(`· phase2 reply audio: ${audioBytes} bytes (~${(audioBytes / 48000).toFixed(1)}s)`);
console.log(
  "· usage:",
  usage
    ? `${usage.totalTokenCount} tok (${(usage.responseTokensDetails ?? []).map((d) => `${d.modality}:${d.tokenCount}`).join(", ")})`
    : "not seen",
);
ws.close();
