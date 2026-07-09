# The OpenAI audio stack: which level of sophistication does the intent pipeline buy?

*Working design notes — 2026-07. This is the narrow question of OpenAI capabilities versus the
input stream we generate: not the interaction design ([turn-flow.md](./turn-flow.md) owns that), not the
channel protocol. Prices and model facts below were read from the model pages on
developers.openai.com in July 2026; API mechanics marked ⚠ should be re-verified against the
current API reference before code relies on them.*

## The cost frame

Three bands, by what they burn (deliberately soft boundaries):

| Band | Burns | Examples |
| --- | --- | --- |
| **Turn flow** | human time | arming, talking, shooting, correcting, sending — the workbench's main subject |
| **Piping to upstream models** | dollars | STT calls, audio-native models, realtime sessions |
| **Cleanup passes** | almost nothing (ms of logic, no LLM) | silence trimming, image downscaling, transcript normalization |

Cleanup gets **two insertion points**, one on each side of the expensive hop:

```
collect (human) → [condition] → pipe ($$$) → [polish] → inject (agent)
```

- **Condition** (pre-pipe): make the upload smaller and cleaner — trim silence, drop empty
  segments, downscale/crop screenshots, dedupe near-identical frames. Saves money *and* latency.
- **Polish** (post-pipe): make the result tidier — apply corrections, strip filler words,
  normalize numbers/units, assemble the Option-C body+meta, size-cap what the agent will Read.

Neither should ever need an LLM; if a "cleanup" wants one, it's actually a pipe stage and should
be priced like one.

## The ladder of sophistication

### L0 — REST STT per segment *(built; the current default)*

`whisper-1` / `gpt-4o-transcribe` / `gpt-4o-mini-transcribe`, one POST per pause-bounded
segment. First bench numbers (`pnpm --filter @habemus-papadum/aiui-workbench bench`, 2026-07,
synthesized speech — treat WER as a floor; long-text WER is mostly number-formatting noise):

| text | audio | model | median ms | RTF | WER% |
| --- | --- | --- | --- | --- | --- |
| short | 1.9s | gpt-4o-mini-transcribe | 1406 | 0.75 | 0.0 |
| medium | 7.5s | gpt-4o-transcribe | 755 | 0.10 | 0.0 |
| long | 21.3s | gpt-4o-mini-transcribe | 1410 | 0.07 | 11.3 |
| xlong | 45.4s | gpt-4o-mini-transcribe | 1531 | 0.03 | 3.0 |
| xlong | 45.4s | whisper-1 | 8317 | 0.18 | 3.0 |

The 4o family has a **~1–1.5 s latency floor that barely grows with utterance length** (RTF
0.75 at 2 s of audio → 0.03 at 45 s); `whisper-1` scales with duration.

- Fits hold-to-talk exactly: PTT release = segment boundary = the API's unit.
- Supports a `prompt` parameter for vocabulary priming (⚠ verify current field name) — the
  keyword hook below.
- Verdict so far: `gpt-4o-mini-transcribe` is the sensible default; nothing observed yet forces
  anything above L0.

### L1 — streaming transcription: `gpt-realtime-whisper`

Streaming STT for live transcript deltas: audio+text in → text out, 16k context,
**$0.017/min of audio** (per-minute, not tokens), "very fast".

- Buys: real partials while you're still talking (the preview stops lying about liveness), and
  upstream turn segmentation (the realtime API's server/semantic VAD ⚠) instead of our keyup.
- Costs: a persistent WS/WebRTC session and its lifecycle; and **per-minute billing makes
  silence literally billable** — an open mic at 70 % silence wastes ~$0.71/hour, so L1 without
  client-side gating (below) is paying for dead air.
- Fits toggle-mode talk better than PTT (long open-mic stretches). The `Transcriber` seam was
  built for exactly this swap; this is the next spike.

### L2 — audio-native chat: `gpt-audio-1.5`

"Best voice model for audio in, audio out with Chat Completions." Text $2.50/M in · $10/M out;
**audio $32/M in · $64/M out**; 128k context; tool calling.

- The interesting workflow (your instinct): **audio comes back as an acknowledgment channel** —
  the model confirms/echoes the composed intent aloud while the *text* goes to the agent.
  Eyes-free operation: you keep looking at the app, not the preview popup.
- ⚠ API mechanics (from the pre-1.5 audio API; re-verify): output modalities are chosen per
  request (`modalities: ["text"]` vs `["text","audio"]`) — so yes, audio-out can be off; and
  when audio *is* produced, the response carries a **transcript of that audio** alongside. That
  answers "is the text a superset of the audio": mechanically yes — transcript and audio are
  generated from the same output tokens, so text remains the single source of truth and the
  agent never needs to hear anything.
- Who hears what, then: human hears audio (optional, ack-flavored), agent reads text, and the
  transcript of the spoken ack can be logged in the trace so the IR records what the human was
  told. No divergence problem by construction.
- Cost note: $64/M audio-out tokens makes chatty spoken responses the expensive part — the ack
  should be a sentence, not a paragraph.

### L3 — full realtime multimodal: `gpt-realtime-2`

"Reasoning model for realtime voice interactions": **text + audio + image in**, text + audio
out, tool calling, configurable reasoning effort, 128k context. Text $4/M in · $24/M out; audio
$32/M in · $64/M out; **image $5/M in**; cached input rates ($0.40/M text·audio, $0.50/M image).

- This is the "maybe we don't need lowering at all" tier: it can ingest the raw stream — speech,
  screenshots, corrections as more speech — and produce the final prompt (or even act, via
  tools).
- My position: **it relocates lowering, it doesn't delete it.** The whole thesis of this repo is
  *inspectable* lowering — IRs you can debug when the prompt comes out wrong. Handing the raw
  stream to an opaque realtime session gives up exactly that. The reconciliation: make the
  realtime model emit a **structured tool call** (`submit_intent{body, meta, attachments…}`) —
  the tool-call schema *is* the IR, the trace records it, and the rest of the pipeline is
  unchanged. L3 then competes as an implementation of the lowering pass, not as a replacement
  for the architecture — and it must beat L0+cleanups on quality enough to justify both the
  dollars and the opacity.
- Cost sanity (⚠ estimate — depends on audio-tokens-per-minute, historically ~600/min in): audio
  input ≈ $0.02/min heard, so an all-day open session ≈ dollars/day *before* reasoning and
  output tokens. Fine as a **mode** you arm; wrong as the always-on default.
- Unknowns to spike: is it fast enough end-to-end? smart enough to run our correction meta-loop
  in-band? does image-in work over the realtime session in practice, and at what resolution?

## What's been done so far

- **Turn system** (Q1): designed and implemented in the main workbench — implicit thread-open on
  first contentful act, Enter/Esc close, PTT-vs-toggle as a setting, correction meta-loop.
  Documented in [turn-flow.md](./turn-flow.md); awaiting your review pass.
- **Transcriber seam**: `transcribe(blob, onDelta) → {text, latencyMs, model}` — mock and
  L0-REST implementations exist; L1/L2/L3 are meant to slot behind the same interface (L1
  trivially; L2/L3 will stretch it — they return more than text — expect the seam to grow a
  structured result).
- **Bench harness**: `bench/transcribe-bench.ts` — say-synthesized references, latency/RTF/WER
  table. First numbers inlined above (L0).
- **Option C lowering + path previews**: body tokens + meta paths, hover-preview in both
  debuggers.

## Open questions, with positions

**Q1 · Turn flow.** Built; see [turn-flow.md](./turn-flow.md). Open sub-question: does L1 streaming change the answer
(server VAD could replace keyup as the segment boundary)? Position: keep the *gesture* (PTT) as
the human-facing contract even if VAD refines the boundaries under it.

**Q2 · How do we think about the speech models?** Position: treat everything as
*implementations of the lowering pass* behind one seam, and let the model lab (below) rank
them. Start simple (L0), spike L1 next because it's cheap and directly improves the felt
preview latency, treat L2's audio-ack as a UX experiment, and gate any L3 work behind the
tool-call-as-IR design so we never lose the trace. Realtime tool calling is promising but
unproven for us on both latency and smarts — that's a lab question, not a debate.

**Q3 · Context/keyword priming.** The transcription APIs accept text context (⚠ `prompt`);
domain words ("baseline", "A-113", "nanometers") are exactly what STT mangles. Where do keywords
come from — page scrape? the tool? a devtool mechanism? Position: **the overlay harvests, the
lowering decides.** The dev overlay already sees the best sources: tab title, headings, the
locator's `data-comp` names, visible text near the pointer — and, best of all, **past
corrections**: every correction the human makes is ground truth that a word matters and gets
mis-heard. Ship candidates as segment metadata; the server-side pass assembles the actual
priming string (dedupe, cap, recency-weight corrections). The backend stays free to ignore it —
keywords are a hint, not the contract. The corpus should include domain-word-dense utterances so
priming's effect is measurable, not vibes.

**Q4 · Silence detection.** Two layers, complementary:
- *Client conditioning (all tiers):* a WebAudio RMS/hangover gate — trim leading/trailing
  silence per segment, split segments at long internal pauses, and drop sub-threshold segments
  entirely (the accidental PTT tap). Pure logic, no LLM, milliseconds. Under per-minute billing
  (L1) this is direct savings; under L0 it mostly buys upload latency; under L2/L3 it saves
  audio-input tokens.
- *Server VAD (L1/L3):* the realtime API's turn detection (server/semantic VAD ⚠) — use it for
  *segmentation*, but still gate on the client so silence never leaves the machine.
The lab should measure: % audio bytes saved, WER delta (aggressive gates clip word onsets —
that's the failure mode to watch), and any latency change.

**Q5 · Audio back to the human.** Covered under L2: audio is an ack channel; text is the source
of truth; transcript-of-audio keeps the trace honest. Open UX questions for the workbench: does
a spoken ack beat the visual preview popup, and does it collide with the human continuing to
talk (barge-in)? Cheap to prototype behind a setting once L2 is wired.

**Q6 · The evaluation corpus.** We need synthetic data shaped like *our* stream, not generic
ASR corpora. Position on storage: **no LFS in this repo.** Two tiers instead:
1. a **generated seed corpus** — a script builds it locally on demand (macOS `say` today,
   OpenAI TTS for voice variety later), so the repo carries only text references + a generator;
2. a **shared frozen corpus** as a downloadable dataset (Hugging Face dataset or a plain
   tarball URL) once we want numbers comparable across machines/time — user runs a fetch
   script, nothing large is committed.
Corpus format stays language-neutral so analysis isn't locked to TS: WAV/webm files + a
`manifest.jsonl`, one record per item:
```jsonc
{ "id": "med-07", "audio": "med-07.wav", "reference": "…exact text…",
  "domainWords": ["baseline", "A-113"], "silence": {"lead": 0.8, "gaps": [2.1]},
  "voice": "say:Samantha", "kind": "utterance" }   // later: "thread" items with shots
```

## The model lab (the "separate page")

A second workbench surface — but CLI-first, because ranking models is a batch job, not an
interaction. Concretely:

1. **`bench/` grows into the lab.** `transcribe-bench.ts` (exists) → `corpus-run.ts` (next):
   take a corpus manifest, run a **matrix** — tier (L0 models, L1, later L2/L3) × conditioning
   (raw vs silence-trimmed) × priming (none vs domainWords) — and emit per-cell latency
   p50/p95, RTF, WER, estimated $ per thread, and bytes saved. Table to stdout, JSON for
   comparison over time.
2. **A thin lab page later, only if it earns it** — loading corpus items into the *interactive*
   workbench (replay a recorded thread against a different tier and watch the IR panes diverge).
   That's the point where a page beats a terminal: diffing composed intents, not reading tables.
3. **TS, not Python — for the runner.** The runner's value is that it exercises the *exact
   request shapes production uses* (same fetch, same FormData, same seam) — rewriting those in
   Python would measure a different client. The corpus being JSONL+WAV keeps the door open for
   Python/notebook analysis of the *results*; if we ever need heavy audio DSP (noise mixing,
   codec sweeps), that can be a Python generator producing the same corpus format without
   touching the runner.

## Proposed order of work

1. Client silence gate (`condition` pass) + its bench column — cheapest win, helps every tier.
2. `corpus-run.ts` + seed-corpus generator (texts + say voices + injected gaps + domain words).
3. L1 spike: `gpt-realtime-whisper` behind the `Transcriber` seam; measure felt preview latency
   against L0's ~1.4 s floor.
4. Priming experiment: domainWords on/off across the corpus (needs the corpus first).
5. L2 audio-ack prototype behind a setting (one-sentence spoken ack; transcript into the trace).
6. L3 design spike *on paper first*: the `submit_intent` tool schema (= the IR), then a small
   live probe of realtime image input + tool reliability before committing to anything.
