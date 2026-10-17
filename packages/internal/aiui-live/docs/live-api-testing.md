# Testing patterns for realtime vendor APIs

A reference for working on the realtime wires this repo speaks — OpenAI Realtime and GPT-Live,
ElevenLabs Scribe, Gemini Live — without a browser, a microphone, or a human clicking. Two
patterns carry the weight today, with a third riding on CI; each is described here as it exists,
with pointers precise enough that the pattern can be extracted into its own lab package later.
Sections marked *sketch* describe things that do not exist yet.

The two patterns answer different questions:

| Pattern | Question it answers | Network | Key | Where |
| --- | --- | --- | --- | --- |
| **Scripted user** (§1) | *What does the vendor actually do?* — latencies, event ordering, delegation, overlapping tasks, what the model says aloud | real vendor | yes | `aiui-live/node`, `demos/live` (grown from the `exploration/live-probe` spike, now in git history) |
| **Injectable socket + scripted fake** (§2) | *Does our engine honor the facts we found?* — handshake shape, correlation rules, commit floors, keepalives, error paths | none | none | every engine's unit tests |
| **Real-wire smoke** (§3) | *Does the wire still work this week?* — one short round trip, shape asserted, quality never | real vendor | yes, gated | the former launcher package's `test/*.e2e.ts` and weekly workflow — retired with it; the pattern is kept here |

Use §1 to learn; use §2 to pin what you learned; use §3 to notice when the vendor moves.

---

## 1. The scripted user — a headless session against the real vendor

The trick: **a session cannot tell synthesized speech from a person.** Turn the utterance into
PCM with the vendor's own TTS, play it into the session at real-time pace with silence in between,
and the whole full-duplex loop — voice activity, transcription, delegation, spoken replies — runs
exactly as it would with a microphone. Everything the model says comes back as PCM and lands in a
WAV a human can listen to afterwards.

### 1.1 The pieces (as they exist in `aiui-live`)

All of it lives in the Node-only subpath [`packages/aiui-live/src/node/`](../src/node/)
(`@habemus-papadum/aiui-live/node`; browser code never imports it):

| Piece | File | What it does |
| --- | --- | --- |
| `synthesize(text, { key, cacheDir })` | [`speech.ts`](../src/node/speech.ts) | Text → 24 kHz mono PCM16 via `POST /v1/audio/speech` (`gpt-4o-mini-tts`, `response_format: "pcm"`). Cached by a hash of `model\|voice\|text`, so a re-run costs nothing. The default voice is `alloy`, **deliberately not a voice the session would use**, so input and reply stay distinguishable on playback. |
| `scriptedMic({ rate, chunkMs })` | `speech.ts` | An `AudioSource`: a 100 ms interval that pushes the next queued chunk, or a chunk of **silence when the queue is empty**. The timeline must stay continuous — VAD and the vendor's clock depend on it. `say(pcm)` queues an utterance and resolves when its last chunk has been *sent*, returning the session-time window it occupied. `sentMs()` is the session clock, approximately. |
| `webSocketTransport({ key, input, onOutputAudio })` | [`ws-transport.ts`](../src/node/ws-transport.ts) | The transport that makes this possible in Node: a `ws` socket with `Authorization: Bearer` (a header a browser WebSocket cannot set), `session.start` as the first frame, the mic's chunks as base64 `session.input_audio.append`, and every `session.output_audio.delta` decoded and handed to `onOutputAudio` before (optionally) being forwarded to the session as an event. |
| `wavSink(rate)` / `pcmToWav` | `speech.ts` | Collects reply PCM; `write(path)` wraps it in a 44-byte RIFF header. `seconds()` is how much the assistant "said" — including silence, which the vendor streams continuously. |

The engine under test, [`LiveSession`](../src/session.ts), takes any
`LiveTransport` — the browser hands it WebRTC, the harness hands it this WebSocket — so the code
exercised headlessly is the production session, not a test double.

### 1.2 The harness — `demos/live/scripts/headless.mts`

[`headless.mts`](../../../demos/live/scripts/headless.mts) is the worked example: a real `gpt-live-1`
session with a synthesized voice as the user and a delegation backend of your choice, including
Claude Code run **in this process** with the demo as its working directory (exactly what the dev
server's relay does for the page).

```sh
pnpm -C demos/live headless scripted                          # the wire alone, a canned backend
pnpm -C demos/live headless responses "set the frequency to four hertz"
pnpm -C demos/live headless claude "why does the trace look jagged at low samples?"
```

Its shape, which is the shape any scripted-user script takes:

1. **A stand-in for the page.** The app's control surface is a plain object with the same tool
   names the real page projects (`set_live_freq`, `live_kick`, `report`), so a backend can be
   judged on its calls without a DOM.
2. **Wire the session** — `scriptedMic` as input, `wavSink` on output audio, the delegator
   picked from argv (`scriptedDelegator` with a fixed delay, `responsesDelegator`,
   `claudeDelegator`), `idle: false` so the session does not self-close mid-script.
3. **Observe through the ledger, not the socket.** `session.onLedger` prints every entry as
   `+t.tts  ←/→/·  kind  summary`; `onState` prints the assistant caption as it changes. The
   ledger is the session's own append-only record (`t` ms since connect, `dir`, `kind`,
   `summary`, the raw `event`, and the prompt-toolkit records behind an append), so the
   harness reads what the widgets read.
4. **Speak, then wait on observable state.** For each utterance: `synthesize` → `mic.say(pcm)`
   → wait for a delegation to open (`session.tasks()` grows) → wait for it to close → wait for
   the assistant to fall silent. *Silence is detected from transcript entries, never from
   audio* — output audio never pauses, silence is streamed too.
5. **Close and report.** Write `out/<backend>.wav`, print billed seconds, and per task the
   three latencies that matter: created → first append, first append → first spoken word, and
   total. Print the stand-in app's final state so a wrong tool call is visible.

The things this is good at, which §2 cannot do: measuring real latencies, discovering what the
model *paraphrases* (the backend's "Frequency set to 5 hertz." becomes "Done."), overlapping
delegations, what a progress note sounds like at 3 s versus 9 s, and whether a reasoning model's
seconds are tolerable in a voice loop.

### 1.3 The origin — `exploration/live-probe/`

`exploration/live-probe/probe.mts` was the standalone spike (own `node_modules`, nothing from
the workspace) the harness was promoted from; it is retired to git history with the rest of
`exploration/`. Its approach remains the better one for a **new vendor or a new feature** because
it had no engine in the way: it spoke the raw socket.

- A `Probe` class per scenario: `connect(session)` opens the socket and resolves on
  `session.started`; `send(ev)` stamps an `event_id` and logs; `startPump()` is the silence-or-
  speech interval; `say(text)` synthesizes and queues; `waitFor(pred, timeoutMs, label)` is the
  one assertion primitive — resolve on the first event matching a predicate over `(event, t)`,
  or `undefined` on timeout.
- Every non-audio frame in either direction is appended to `out/<scenario>.jsonl` as
  `{ t, dir, ev }` with `t` in ms since socket open. The assistant's audio goes to
  `out/<scenario>.wav`. **These logs are the primary record** — the measured table in
  [oracle-live.md §4](./oracle-live.md#4-what-we-measured) was read off them.
- Scenarios are named functions in a registry (`models`, `context`, `client`, `long`,
  `responses`, `sideband`), each a short script: connect, speak, wait for the event of
  interest, send the thing you are probing, wait for its ack and for the first spoken
  transcript delta after it, log the deltas, close. The `client` scenario is the template.

The pattern, stated once: *synthesize → pace → wait for the event you care about → log with a
timestamp → listen back.* Everything else is vendor dialect.

### 1.4 The voice-free sibling — `tools-bench.mts` (retired with the intent tool)

`demos/live/scripts/tools-bench.mts` judged a delegation backend on an app's **real page tools**
with no voice model at all: the tool document came from the intent tool's channel ledger (its
`/debug/api/page-tools`), each call executed in the live page over CDP (`Runtime.evaluate`
only), and the backend was the same delegator the relay would run. It needed the intent tool
running — its `aiui claude` session and its client relaying the app's tab — and the app open,
so it left this repo with that tool (git history keeps it). The pattern stands: use a bench of
this shape when the question is "did the backend pick the right tool" rather than "what did the
voice do".

---

## 2. The injectable socket and the scripted fake — pinning the facts offline

Every realtime engine in the repo takes its upstream socket from a **factory** the caller
injects. Production injects a `ws`-backed factory; the unit tests inject a fake that the test
drives like the vendor. The whole session state machine then runs with no network and no key,
and each wire fact learned in §1 becomes an assertion that fails if the engine drifts.

### 2.1 The seam

In `aiui-stt` ([`support.ts`](../../aiui-stt/src/support.ts), a browser-side port of the former
channel's `session-core.ts`):

```ts
type SttSocketFactory = (url: string, protocols: string[] | undefined, handlers: SttSocketHandlers) => SttSocket;
interface SttSocket { send(text: string): void; close(): void }
interface SttSocketHandlers {
  onOpen(): void;
  onMessage(text: string): void;
  onError(message: string): void;
  onClose(code?: number, reason?: string): void;    // vendors put the real error in `reason`
}
```

`browserSocketFactory` is the production implementation — the platform `WebSocket`, with
credentials riding the URL or a subprotocol, since a browser cannot set request headers. In the
former channel's node engines the same seam took `(url, apiKey, handlers)` and
`makeWsSocketFactory(auth)` was the production side; there `auth` was the **only per-vendor
difference** at this layer — a bearer header (OpenAI), an `xi-api-key` header (ElevenLabs), or a
`?key=` query param (Gemini) — and the handshake's rejected status and body were captured too
(a browser sees only the close frame). Everything above the factory — the ready gate that buffers
frames until the vendor's ready signal, the drain controller, the close-reason capture — is
shared between engines.

The same shape exists one level higher in the oracle's and live session's transport interfaces
(`OracleTransport`, `LiveTransport`) — a transport, not a socket — because those sessions run
over WebRTC in the browser.

### 2.2 The fake

[`aiui-stt/src/test-support/fakes.ts`](../../aiui-stt/src/test-support/fakes.ts) is the shared
scripted fake for both STT engines (`fakeSocket()`, plus `recordingCallbacks()` and `pcmMs(n)`
for zeroed audio of a known duration). It is a port of the former channel's `fake-upstream.ts`,
the one superset-shaped fake its four engines (two STT, two linter) shared, each vendor's earlier
local fake having been a subset of it.

```ts
const socket = fakeSocket();
const transport = scribeTransport({ connectUrl, socketFactory: socket.factory });
socket.url(), socket.protocols()   // what the engine connected with (config can live in the query string)
socket.sent, socket.sentJson()     // every frame the engine sent, raw and parsed
socket.open()                      // fire the socket open
socket.message({ ...serverEvent }) // deliver a server frame
socket.error("boom")               // a transport fault
socket.close(1007, "API key not valid")
socket.closed()                    // did the engine close the socket
```

The test is the vendor: it opens, replies to the handshake, feeds deltas and finals in the order
(or the wrong order) the real service was seen to use, and asserts on `socket.sent` and on what
the engine's callbacks received. The oracle's and live session's tests build a `fakeTransport()`
inline with the same three verbs: `sent`, `emit`, `dropFrom`.

### 2.3 What gets pinned

The pattern is only as good as the facts fed into it, so the convention is strict: **every pin
mirrors a behavior verified live**, and the engine's header comment records the verification
("live-verified against the real service", with the date and the probe). Representative pins,
one per engine:

- **OpenAI STT** ([`aiui-stt/src/openai.test.ts`](../../aiui-stt/src/openai.test.ts); the
  former channel's `realtime.test.ts` pinned the node side): the GA `session.update` shape (no
  beta header, nested `audio.input`), `turn_detection: null` for manual commit, `delay`
  omitted when unset (an empty string 400s), incremental deltas accumulate, an unseen
  `item_id` before commit belongs to the segment streaming now.
- **ElevenLabs Scribe** ([`aiui-stt/src/scribe.test.ts`](../../aiui-stt/src/scribe.test.ts); the
  former channel's `elevenlabs-realtime.test.ts` was the original): all config rides the
  connect URL; `keyterms` must be *repeated plain* params — the bracket form is silently
  dropped; there is no `commit_strategy` parameter; the `session_started` echo is the only
  proof a param took effect (`checkConfigEcho`); the commit floor; the idle keepalive armed
  only from real sends; FIFO correlation since the wire carries no item ids.
- **Gemini Live** (the former channel's `gemini-live.test.ts`, now outside this repo): raw
  frames, not the SDK (whose transformer drops `realtimeInputConfig`); manual VAD; the
  window-ordering rule (a label or frame sent before the window's first audio is queued and
  flushed after it); `goAway` time-left parsing; resumption and compression in the setup.
- **OpenAI live linter** (the former channel's `openai-live.test.ts`, likewise): manual VAD,
  `read_file` as the one tool, no input transcription (the STT session owns the chronicle).
- **The live session** ([`aiui-live/src/session.test.ts`](../src/session.test.ts)):
  tickets, appends and their acks, request text from the transcript, the hosted function-call
  loop, chunking at the 500-token append limit, progress notes, idle close and re-seed.
- **The oracle** ([`aiui-oracle/src/session.test.ts`](../../aiui-oracle/src/session.test.ts)):
  `event_id` stamping, the completed-response tool gate, in-band tool errors, park semantics,
  unknown vendor events retained as `raw`.

A nuance worth knowing: the fakes are **hand-authored, not replayed**. The probe's JSONL logs
inform the frames a test emits, but no test reads a recording; each emits the minimal frames
that express one fact. That keeps a test readable as a statement of the fact, at the cost of
having to transcribe it.

---

## 3. The real-wire smoke — one short round trip, weekly

This tier lived in the former launcher package and left with the intent tool; it is described
here so the pattern can be re-created (from git history) wherever a wire needs weekly watching.
Its `openai-realtime.e2e.ts` streamed a checked-in WAV through the channel's production
`openRealtimeSession` — 100 ms frames with a 20 ms pacing sleep, one `commit` — and asserted
round-trip **shape** only: at least one delta, a non-empty final, a recorded latency. Its sibling
`openai-pipeline.e2e.ts` posted the same WAV to REST transcription and round-tripped the
correction prompt and a TTS ack.

The conventions that made this safe to leave running:

- **The fixture is committed, not generated.** `test/fixtures/segment.wav` is ~2 s of 16 kHz
  mono PCM16 made once with macOS `say` and `afconvert`; CI runners are Linux. The realtime
  test resamples it to 24 kHz in-test with a linear interpolation, no new dependency — the
  keyless cousin of §1's `synthesize`.
- **The marker is the file name.** `*.e2e.ts` is never collected by `pnpm test`; it ran only
  through a dedicated `vitest.e2e.config.ts` (`pnpm test:e2e`), serially, with two-minute
  timeouts.
- **The key is the gate.** `describe.skipIf(!OPENAI_API_KEY)` keeps forks and offline runs
  green. The weekly workflow was a scheduled `openai-e2e.yml`; cost is cents per run, by
  design.
- **Quality is never asserted.** Latency curves and model comparisons were measured by hand in
  §1-style sessions; this tier only says "the wire still answers in the shape we expect".

---

## 4. Choosing, and the lifecycle of a fact

```
new vendor, new feature, "what does it really do?"
        │
        ▼
  §1 scripted user (a probe scenario; JSONL + WAV in out/)
        │  read the log, listen to the WAV, write the numbers down
        ▼
  the engine's header comment: the verified wire surface, dated
        │
        ▼
  §2 fake-driven unit tests: one `it` per fact, minimal frames
        │
        ▼
  §3 one e2e round trip, key-gated, weekly: the vendor moved → we hear about it
```

Rules of thumb that have held:

- Verify a parameter took effect by the vendor's **config echo**, never by the absence of an
  error — ElevenLabs and OpenAI both accept unknown params silently.
- Detect "the assistant is speaking" from **transcript deltas**, never from audio; output audio
  is continuous.
- Keep the probe's `waitFor(pred, timeout)` honest: a timeout returns `undefined` and the
  scenario logs it, rather than throwing, so one missing event does not hide the rest of the
  log.
- Cache synthesized utterances by content hash; the same sentence across fifty runs should cost
  one TTS call.
- Pick a TTS voice the session will never use for replies.

---

## 5. Sketches — what does not exist yet

### 5.1 Scripted-user sessions for ElevenLabs and Gemini (*sketch*)

ElevenLabs has its §2 fakes in `aiui-stt`; Gemini's engine and fakes left with the channel.
Neither has a §1 harness or a §3 smoke here. The pieces compose without new abstractions:

- **Audio in.** `scriptedMic` already produces paced 24 kHz PCM16 chunks; both engines accept
  that rate (`audio_format=pcm_24000`; Gemini accepts 24 kHz though it prefers 16). The mic's
  `push` becomes the engine's `appendAudio`, and the commit (ElevenLabs) or activity window
  (Gemini) is sent when `say()` resolves.
- **The socket.** Use the engine's own production factory (`aiui-stt`'s `browserSocketFactory`
  in a browser; the former channel's `makeWsSocketFactory` with the vendor's `auth` in node) —
  the point is the real wire, through the real engine.
- **Observation.** The engines report through callbacks (`onDelta`/`onFinal`/`onDiagnostic`
  for STT; `onReplyTranscript`/`onReplyAudio`/`onInterrupted`/`onGoAway` for the linter).
  Append each callback to a JSONL with `t` since open, exactly as the probe does; collect
  `onReplyAudio` into a `wavSink` (Gemini replies at 24 kHz PCM).
- **Scenarios worth having first.** ElevenLabs: the self-commit behavior across long pauses,
  keyterm bias on a domain word, the keepalive under a long silence. Gemini: the window
  rule with a labeled image mid-utterance, barge-in, `goAway` and resumption, a `read_file`
  call round trip.
- **Promotion to §3.** Each scenario's minimal form — one utterance, one final — becomes a
  key-gated `*.e2e.ts` (`ELEVEN_LABS_API_KEY` / `GEMINI_API_KEY`) using the committed WAV,
  added as steps to a weekly workflow — the tier §3 describes, re-created wherever it lands.

### 5.2 A generic lab package (*sketch*)

If the scripted user is extracted from `aiui-live/node` into its own never-published package
(say `packages/aiui-voice-lab`, `--no-publish`), the surface is small and vendor-neutral:

| Export | From | Notes |
| --- | --- | --- |
| `AudioSource`, `scriptedMic` | `aiui-live/node/speech.ts`, `ws-transport.ts` | unchanged; the interface is three verbs (`start(push)`, `stop`, `setEnabled`) |
| `synthesize` | `speech.ts` | add a `provider` seam: OpenAI TTS (default) and a `say`+`afconvert` provider for keyless macOS runs — the fixture already proves the path |
| `pcmToWav`, `wavSink`, `pcmFromWav` | `speech.ts` + the e2e's reader/resampler | one WAV module instead of three |
| `eventLog(label)` | the probe's `Probe` | the JSONL writer: `{ t, dir, ev }`, audio frames excluded |
| `waitFor(pred, timeoutMs, label)` | the probe | over any event stream; returns `undefined` on timeout |
| `scenario(name, fn)` + a CLI | the probe's registry | `pnpm lab <scenario>…`, `out/` per scenario |

Vendor dialect stays in the engines; the lab package only knows PCM, time, and JSON lines. The
first consumers would be `headless.mts` (unchanged behavior) and the two §5.1 harnesses.

### 5.3 A headless oracle (*sketch*)

The oracle runs over WebRTC with the live mic as its only input — a recorded owner decision
(see the header of [`webrtc.ts`](../../aiui-oracle/src/webrtc.ts)). A headless oracle
would need a second `OracleTransport` over WebSocket with PCM injection, the mirror image of
`aiui-live`'s `webSocketTransport`; OpenAI Realtime supports that transport. The session engine
would need no change — its tests already drive it through a scripted transport. This is listed
for completeness; it is a decision to revisit, not a gap to close.

---

## Pointers

- [`packages/aiui-live/src/node/`](../src/node/) — `speech.ts`,
  `ws-transport.ts`, `backend.ts`; the subpath `@habemus-papadum/aiui-live/node`.
- [`demos/live/scripts/headless.mts`](../../../demos/live/scripts/headless.mts); the demo's
  [README](../../../demos/live/README.md) ("Without a microphone"). `tools-bench.mts` is in git
  history.
- `exploration/live-probe/` (retired to git history) — the probe and its README's scenario
  table; [oracle-live.md §4](./oracle-live.md#4-what-we-measured) for the numbers.
- [`packages/aiui-stt/src/support.ts`](../../aiui-stt/src/support.ts) (the seam),
  [`test-support/fakes.ts`](../../aiui-stt/src/test-support/fakes.ts) (the fake), the two
  engine test files beside them. The former channel's `session-core.ts`, `fake-upstream.ts`
  and four engine tests are in git history.
- The e2e tier (the former launcher package's `test/`, its fixture, `vitest.e2e.config.ts`
  and the weekly `openai-e2e.yml`) — git history.
