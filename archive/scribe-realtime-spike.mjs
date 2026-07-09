/**
 * Scribe v2 realtime spike (July 2026) — does ElevenLabs commit utterances on
 * its OWN, mid-stream, even under `commit_strategy=manual`?
 *
 * Run: node archive/scribe-realtime-spike.mjs   (needs ELEVEN_LABS_API_KEY in
 * .env.dev; macOS `say` synthesizes the audio, so no fixture is checked in.)
 *
 * WHY: a live trace (demos/july09, 2026-07-09) showed a 134-second push-to-talk
 * segment produce an EMPTY final transcript. Its recorded partials grew to 194
 * chars, then reset to 8 mid-segment, grew to 265, then stopped entirely for the
 * last 62 seconds. The channel's ElevenLabs session correlates results to
 * segments positionally (no item ids on this wire): commits enter a FIFO, and
 * `completeHead` DROPS any completion that arrives when that FIFO is empty
 * ("stray, ignore" — elevenlabs-realtime.ts). During a held PTT the FIFO is
 * always empty, so a server-side utterance close would be silently discarded and
 * the partial would restart from zero — exactly what the trace shows. But the
 * drop is silent by construction, so the trace cannot prove Scribe sent anything.
 *
 * This reproduces the shape with no browser and no channel: stream ~35 s of
 * synthesized speech with filler words, a 9 s mid-utterance pause (the trace's
 * gap), then 20 s of trailing silence — and NEVER commit until the very end,
 * exactly as a held push-to-talk does. Every raw frame is logged verbatim.
 *
 * The two questions it answers:
 *   Q1. Does `session_started` echo `commit_strategy=manual` back? (Scribe
 *       accepts unknown query params SILENTLY, so the echo is the only proof a
 *       param took effect — and the channel never inspects it.)
 *   Q2. Do any `committed_transcript*` frames arrive BEFORE we commit? If yes,
 *       the channel is dropping real transcript on the floor.
 *
 * FINDINGS (verified live against scribe_v2_realtime, 2026-07-09):
 *
 *  1. `commit_strategy=manual` IS NOT A REAL PARAMETER. The `session_started`
 *     config echo does not contain it — not as `commit_strategy`, not under any
 *     alias. Scribe accepted it silently and ignored it, exactly as this repo's
 *     own docstring warns ("the only reliable proof a param took effect is the
 *     `session_started` config echo"). The channel has never verified that echo,
 *     so the whole "PTT owns the boundary" premise was never in force.
 *     The real knobs it echoes: `vad_commit_strategy: false`,
 *     `vad_silence_threshold_secs: 1.5`, `vad_threshold: 0.4`,
 *     `min_speech_duration_ms: 100`, `max_tokens_to_recompute: 5`.
 *
 *  2. SCRIBE COMMITS UTTERANCES ON ITS OWN, UNPROMPTED, MID-STREAM. At t=38.2s,
 *     having sent no commit of any kind, we received `committed_transcript`
 *     (399 chars) and then `committed_transcript_with_timestamps` (399 chars,
 *     145 words). Note this fired ~9 s AFTER the 9 s silence pause ended, not
 *     during it — and `vad_commit_strategy` is `false` — so it is not the silence
 *     VAD. It is a cap on utterance length/tokens (~37 s of audio here; the
 *     production trace's utterance ran ~43 s before the same thing happened).
 *     There is no observed way to switch it off.
 *
 *  3. THE CHANNEL DROPS BOTH FRAMES ON THE FLOOR (elevenlabs-realtime.ts):
 *       - `committed_transcript` → `case: return;` (deliberately ignored, since
 *         the timestamped twin is treated as authoritative)
 *       - `committed_transcript_with_timestamps` → `completeHead()` →
 *         `committed.shift()` is undefined (our FIFO is empty until talk-end) →
 *         `return; // stray, ignore`
 *     So 399 characters of real transcript are discarded, silently, with no
 *     trace stage and no error.
 *
 *  4. THE PARTIAL THEN RESETS: 388 → 6 chars ("Mm-hmm"). The dev overlay's
 *     preview does `deltaTail.set(segment, text)` — a faithful replace — so the
 *     user watches ~390 characters of their own speech vanish. Nothing in our
 *     code diffed or patched anything. The reset is upstream.
 *
 *  5. OUR EVENTUAL COMMIT ONLY RETURNS THE TAIL. At t=65.2s we finally commit;
 *     Scribe answers with the text since ITS OWN commit — 121 chars — not the
 *     full 520. In the production trace the tail was pure silence, so the segment
 *     finalized EMPTY (0 chars, no words), losing all 134 s of speech.
 *
 *  CONCLUSION: the bug is a dropped vendor message, not a diff/fold error. Fix
 *  direction: consume the unprompted completion — attribute a terminal frame
 *  arriving on an empty FIFO to the currently-streaming segment and ACCUMULATE
 *  it, so a segment's final text is the concatenation of every utterance Scribe
 *  closed inside it. (And ideally assert the `session_started` echo, so the next
 *  silently-ignored query param fails loudly instead of quietly.)
 *
 *  SIBLING RISK: OpenAI's realtime path has the same shape of hole — a bare
 *  `default: return` plus two `if (segment === undefined) return` drops — and it
 *  never handles `conversation.item.input_audio_transcription.failed` at all.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";

// Node's global WebSocket cannot set request headers, and Scribe authenticates
// with `xi-api-key`. pnpm's store keeps `ws` out of ESM resolution from here, so
// reach it through CJS — the same `ws` the channel itself uses.
const WebSocket = createRequire(import.meta.url)("ws");

// ── config ───────────────────────────────────────────────────────────────────
const SAMPLE_RATE = 24000;
const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000; // 48 — PCM16 mono
const FRAME_MS = 120; // the client's chunk cadence (5760 bytes)
const TRAILING_SILENCE_MS = 20_000; // mimic holding talk after you stop speaking
const MID_PAUSE_MS = 9000; // the trace's 9.5 s gap, via say's [[slnc]]

// Filler words and false starts on purpose: they are what `no_verbatim=true`
// rewrites, so revisions (not just growth) show up in the partial stream.
const SCRIPT = [
  "Okay, so, um, I'd like to build an app that measures how accurately I can draw a circle.",
  "So, basically, uh, I'm going to draw a circle like this, and, um, as I'm drawing,",
  "I want the app to record dots, and, you know, also show the full stroke interpolated.",
  `[[slnc ${MID_PAUSE_MS}]]`,
  "And the distance, uh, I mean, maybe the distance from the beginning of my stroke to the end of the stroke.",
  "It should start calculating various statistics, like, um, eccentricity, and area,",
  "and maybe some measure of the local fluctuations in the curvature, or, uh, the quality of the stroke.",
].join(" ");

const key = readFileSync(new URL("../.env.dev", import.meta.url), "utf8")
  .split("\n")
  .find((l) => l.startsWith("ELEVEN_LABS_API_KEY="))
  ?.slice("ELEVEN_LABS_API_KEY=".length)
  .trim();
if (!key) {
  console.error("no ELEVEN_LABS_API_KEY in .env.dev");
  process.exit(1);
}

// ── synthesize the audio with `say` → raw PCM16 @ 24 kHz mono ────────────────
const wavPath = "/tmp/scribe-spike.wav";
execFileSync("say", [
  "-o",
  wavPath,
  "--data-format=LEI16@24000",
  "--channels=1",
  "-r",
  "170",
  SCRIPT,
]);

/** Walk RIFF chunks to the `data` payload — `say` emits JUNK/FLLR padding first. */
function wavPcm(path) {
  const b = readFileSync(path);
  let o = 12;
  while (o < b.length - 8) {
    const id = b.subarray(o, o + 4).toString("latin1");
    const size = b.readUInt32LE(o + 4);
    if (id === "data") {
      return b.subarray(o + 8, o + 8 + size);
    }
    o += 8 + size + (size % 2);
  }
  throw new Error("no data chunk");
}

const speech = wavPcm(wavPath);
unlinkSync(wavPath);
const silence = Buffer.alloc(TRAILING_SILENCE_MS * BYTES_PER_MS); // digital zeros
const pcm = Buffer.concat([speech, silence]);
console.log(
  `audio: ${(speech.length / BYTES_PER_MS / 1000).toFixed(1)}s speech + ` +
    `${TRAILING_SILENCE_MS / 1000}s trailing silence = ${(pcm.length / BYTES_PER_MS / 1000).toFixed(1)}s\n`,
);

// ── connect, with EXACTLY the channel's query string ─────────────────────────
const url = new URL("wss://api.elevenlabs.io/v1/speech-to-text/realtime");
url.searchParams.set("model_id", "scribe_v2_realtime");
url.searchParams.set("audio_format", `pcm_${SAMPLE_RATE}`);
url.searchParams.set("include_timestamps", "true");
url.searchParams.set("no_verbatim", "true");
url.searchParams.set("commit_strategy", "manual");

const t0 = Date.now();
const rel = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
// Audio waits for `session_started`, exactly as the channel's outbox does.
let onReady = () => {};
const ready = new Promise((resolve) => {
  onReady = resolve;
});
const seen = new Map(); // message_type -> count
const beforeCommit = []; // terminal frames that arrived before WE committed
let committedYet = false;
let lastPartial = "";
const resets = [];

const ws = new WebSocket(url.toString(), { headers: { "xi-api-key": key } });

ws.on("open", () => console.log(`${rel()} open (no config frame — the URL is the config)`));

ws.on("message", (data) => {
  const raw = String(data);
  let m;
  try {
    m = JSON.parse(raw);
  } catch {
    console.log(`${rel()} !! unparseable frame: ${raw.slice(0, 120)}`);
    return;
  }
  const type = m.message_type ?? "(no message_type)";
  seen.set(type, (seen.get(type) ?? 0) + 1);

  if (type === "session_started") {
    // Q1: the config echo — the only proof a query param took effect.
    console.log(`${rel()} session_started · FULL PAYLOAD:`);
    console.log(JSON.stringify(m, null, 2).replace(/^/gm, "         "));
    onReady();
    return;
  }

  if (type === "partial_transcript") {
    const text = m.text ?? "";
    // A RESET is the vendor abandoning its running text (a new utterance); a
    // REVISION is it rewording what it already had. Only the first destroys data.
    if (lastPartial !== "" && text.length < lastPartial.length * 0.6) {
      resets.push({ at: rel(), from: lastPartial.length, to: text.length });
      console.log(
        `${rel()} partial  ⚠ RESET ${lastPartial.length} → ${text.length} chars  ${JSON.stringify(text.slice(0, 40))}`,
      );
    } else {
      const flag = text.length < lastPartial.length ? "~" : " ";
      console.log(
        `${rel()} partial ${flag}${String(text.length).padStart(4)} chars  …${JSON.stringify(text.slice(-42))}`,
      );
    }
    lastPartial = text;
    return;
  }

  // Everything else: terminal frames, errors, and anything undocumented. The
  // channel's switch has a silent `default` — this is where a dropped message
  // would hide.
  const isTerminal = type.startsWith("committed_transcript");
  if (isTerminal && !committedYet) {
    beforeCommit.push({ at: rel(), type, chars: (m.text ?? "").length });
    console.log(`${rel()} ★★ ${type} BEFORE OUR COMMIT — ${(m.text ?? "").length} chars`);
    console.log(`         text: ${JSON.stringify((m.text ?? "").slice(0, 100))}`);
    if (Array.isArray(m.words)) console.log(`         words: ${m.words.length}`);
    return;
  }
  console.log(`${rel()} ${type}  ${JSON.stringify(m).slice(0, 160)}`);
});

ws.on("error", (e) => console.log(`${rel()} socket error: ${e.message ?? e}`));
ws.on("close", (code, reason) => {
  console.log(`${rel()} closed (${code}) ${String(reason) || ""}`);
  report();
  process.exit(0);
});

// ── stream in real time, committing only at the very end ─────────────────────
const CHUNK = FRAME_MS * BYTES_PER_MS;
let offset = 0;

async function stream() {
  // Wait for readiness the way the session does — queue until session_started.
  await ready;
  while (offset < pcm.length) {
    const slice = pcm.subarray(offset, offset + CHUNK);
    offset += CHUNK;
    ws.send(
      JSON.stringify({
        message_type: "input_audio_chunk",
        audio_base_64: slice.toString("base64"),
        commit: false,
        sample_rate: SAMPLE_RATE,
      }),
    );
    await new Promise((r) => setTimeout(r, FRAME_MS));
  }
  console.log(`\n${rel()} ── all audio sent; NOW committing (as talk-end would) ──\n`);
  committedYet = true;
  ws.send(
    JSON.stringify({
      message_type: "input_audio_chunk",
      audio_base_64: "",
      commit: true,
      sample_rate: SAMPLE_RATE,
    }),
  );
  setTimeout(() => {
    ws.close();
  }, 6000);
}

function report() {
  console.log("\n══════════════════════ SUMMARY ══════════════════════");
  console.log("message types seen:");
  for (const [t, n] of [...seen].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${t}`);
  }
  console.log(`\nQ2: terminal frames BEFORE our commit: ${beforeCommit.length}`);
  for (const b of beforeCommit) console.log(`  ${b.at}  ${b.type}  ${b.chars} chars`);
  console.log(`\npartial resets observed: ${resets.length}`);
  for (const r of resets) console.log(`  ${r.at}  ${r.from} → ${r.to} chars`);
  console.log("═════════════════════════════════════════════════════");
}

stream();
