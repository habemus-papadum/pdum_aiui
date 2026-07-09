/**
 * OpenAI realtime transcription spike (July 2026) — the sibling of
 * `scribe-realtime-spike.mjs`. Does the GA transcription session commit
 * utterances on its own the way ElevenLabs Scribe does?
 *
 * Run: node archive/openai-realtime-spike.mjs   (needs OPENAI_API_KEY in .env.dev;
 * macOS `say` synthesizes the audio, so no fixture is checked in.)
 *
 * WHY: Scribe self-committed a long utterance and the channel dropped it, losing
 * a user's two-minute prompt. OpenAI's session sets `turn_detection: null`, which
 * is supposed to mean "the client owns the turn boundary" — but Scribe's
 * `commit_strategy=manual` was supposed to mean that too, and no such parameter
 * ever existed. So: hold one 63-second "push-to-talk" open, never commit until the
 * end, and log every frame the server sends.
 *
 * FINDINGS (verified live against gpt-realtime-whisper, 2026-07-09):
 *
 *  1. OPENAI DOES NOT HAVE SCRIBE'S BUG. Across a 63 s hold with no commit:
 *     `completed BEFORE our commit: 0`, and exactly **one** transcription
 *     `item_id` for the whole segment. The single `…transcription.completed`
 *     arrived 0.4 s after our commit with the FULL 536-character transcript.
 *     Nothing was lost, and the channel's item-id correlation held.
 *
 *  2. `turn_detection: null` IS REAL, and the echo proves it. `session.updated`
 *     comes back with `turn_detection: null` and
 *     `transcription: {model: "gpt-realtime-whisper", language: null, prompt: null}`.
 *     Contrast Scribe, where the analogous `commit_strategy=manual` was never
 *     echoed because it never existed. This is exactly why the echo is now
 *     asserted on both vendors rather than assumed on either.
 *
 *  3. Deltas DO stream while audio appends: 121 of them, all on the one item —
 *     so the preview fills as you talk, and (unlike Scribe) the cumulative text
 *     never resets, because the utterance is never closed early.
 *
 *  4. Message types the session silently ignored before this work, all benign
 *     bookkeeping with no transcript in them — but they were indistinguishable
 *     from a message that mattered, which is the whole point:
 *       session.created · input_audio_buffer.committed ·
 *       conversation.item.added · conversation.item.done
 *     They now surface as `unhandled` diagnostics.
 *
 *  5. NOT exercised here: `conversation.item.input_audio_transcription.failed`,
 *     a real OpenAI event the module never handled at all — an unhandled failure
 *     left the segment in `pending` until the drain timeout, indistinguishable
 *     from silence. Now routed to `onError(reason, segment)`.
 *
 *  CONCLUSION: the OpenAI path needed hardening (echo assertion, `.failed`,
 *  no silent `default`), not the accumulation surgery ElevenLabs required. Its
 *  correlation is item-id based rather than positional, which is why it survived.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";

const WebSocket = createRequire(import.meta.url)("ws");

const SAMPLE_RATE = 24000;
const BYTES_PER_MS = 48;
const FRAME_MS = 120;
const TRAILING_SILENCE_MS = 20_000;
const MODEL = "gpt-realtime-whisper";

const SCRIPT = [
  "Okay, so, um, I'd like to build an app that measures how accurately I can draw a circle.",
  "So, basically, uh, I'm going to draw a circle like this, and, um, as I'm drawing,",
  "I want the app to record dots, and, you know, also show the full stroke interpolated.",
  "[[slnc 9000]]",
  "And the distance, uh, I mean, maybe the distance from the beginning of my stroke to the end of the stroke.",
  "It should start calculating various statistics, like, um, eccentricity, and area,",
  "and maybe some measure of the local fluctuations in the curvature, or, uh, the quality of the stroke.",
].join(" ");

const key = readFileSync(new URL("../.env.dev", import.meta.url), "utf8")
  .split("\n")
  .find((l) => l.startsWith("OPENAI_API_KEY="))
  ?.slice("OPENAI_API_KEY=".length)
  .trim();
if (!key) {
  console.error("no OPENAI_API_KEY in .env.dev");
  process.exit(1);
}

const wav = "/tmp/openai-spike.wav";
execFileSync("say", ["-o", wav, "--data-format=LEI16@24000", "--channels=1", "-r", "170", SCRIPT]);
function wavPcm(path) {
  const b = readFileSync(path);
  let o = 12;
  while (o < b.length - 8) {
    const id = b.subarray(o, o + 4).toString("latin1");
    const size = b.readUInt32LE(o + 4);
    if (id === "data") return b.subarray(o + 8, o + 8 + size);
    o += 8 + size + (size % 2);
  }
  throw new Error("no data chunk");
}
const pcm = Buffer.concat([wavPcm(wav), Buffer.alloc(TRAILING_SILENCE_MS * BYTES_PER_MS)]);
unlinkSync(wav);
console.log(`audio: ${(pcm.length / BYTES_PER_MS / 1000).toFixed(1)}s total\n`);

const t0 = Date.now();
const rel = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
const seen = new Map();
const completedBeforeCommit = [];
const itemIds = new Set();
let committedYet = false;
let ready;
const readyP = new Promise((r) => {
  ready = r;
});

const ws = new WebSocket("wss://api.openai.com/v1/realtime?intent=transcription", {
  headers: { Authorization: `Bearer ${key}` },
});

ws.on("open", () => {
  console.log(`${rel()} open → sending session.update (turn_detection: null)`);
  ws.send(
    JSON.stringify({
      type: "session.update",
      session: {
        type: "transcription",
        audio: {
          input: {
            format: { type: "audio/pcm", rate: SAMPLE_RATE },
            transcription: { model: MODEL },
            turn_detection: null,
          },
        },
        include: ["item.input_audio_transcription.logprobs"],
      },
    }),
  );
});

ws.on("message", (data) => {
  const m = JSON.parse(String(data));
  const type = m.type ?? "(none)";
  seen.set(type, (seen.get(type) ?? 0) + 1);

  if (type === "session.updated") {
    const input = m.session?.audio?.input;
    console.log(
      `${rel()} session.updated · turn_detection = ${JSON.stringify(input?.turn_detection)}`,
    );
    console.log(`         transcription = ${JSON.stringify(input?.transcription)}`);
    ready();
    return;
  }
  if (type === "conversation.item.input_audio_transcription.delta") {
    itemIds.add(m.item_id);
    return; // too chatty to print; item ids are what matter
  }
  if (type === "conversation.item.input_audio_transcription.completed") {
    const chars = (m.transcript ?? "").length;
    if (!committedYet) {
      completedBeforeCommit.push({ at: rel(), item: m.item_id, chars });
      console.log(`${rel()} ★★ COMPLETED BEFORE OUR COMMIT — item ${m.item_id}, ${chars} chars`);
    } else {
      console.log(`${rel()} completed — item ${m.item_id}, ${chars} chars`);
      console.log(`         ${JSON.stringify((m.transcript ?? "").slice(0, 120))}`);
    }
    return;
  }
  if (type === "error") {
    console.log(`${rel()} ERROR ${JSON.stringify(m.error)}`);
    return;
  }
  console.log(`${rel()} ${type}  ${JSON.stringify(m).slice(0, 140)}`);
});

ws.on("error", (e) => console.log(`${rel()} socket error: ${e.message}`));
ws.on("close", (code, reason) => {
  console.log(`${rel()} closed (${code}) ${String(reason)}`);
  report();
  process.exit(0);
});

async function stream() {
  await readyP;
  let offset = 0;
  while (offset < pcm.length) {
    const slice = pcm.subarray(offset, offset + FRAME_MS * BYTES_PER_MS);
    offset += FRAME_MS * BYTES_PER_MS;
    ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: slice.toString("base64") }));
    await new Promise((r) => setTimeout(r, FRAME_MS));
  }
  console.log(`\n${rel()} ── all audio sent; NOW committing (as talk-end would) ──\n`);
  committedYet = true;
  ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
  setTimeout(() => ws.close(), 8000);
}

function report() {
  console.log("\n══════════════════════ SUMMARY ══════════════════════");
  console.log("message types seen:");
  for (const [t, n] of [...seen].sort((a, b) => b[1] - a[1]))
    console.log(`  ${String(n).padStart(4)}  ${t}`);
  console.log(`\ndistinct transcription item_ids: ${itemIds.size}  ${[...itemIds].join(", ")}`);
  console.log(`completed BEFORE our commit: ${completedBeforeCommit.length}`);
  for (const c of completedBeforeCommit) console.log(`  ${c.at}  ${c.item}  ${c.chars} chars`);
  console.log("═════════════════════════════════════════════════════");
}

stream();
