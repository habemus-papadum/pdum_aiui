# Transcription mode and realtime mode — the submode split

*(July 2026. The deep-dive companion to
[pipeline-and-interaction-model.md](./pipeline-and-interaction-model.md): that document maps the
whole pipeline and work plan; this one drills into exactly one of its questions — what §B.1
called the "composer axis" — and recasts it the way it should be built: as two **submodes** of
the web intent tool. Read that document's §A first; this one assumes its vocabulary.)*

*(Vendor facts below were verified against the live docs in July 2026 —
[Gemini Live API](https://ai.google.dev/gemini-api/docs/live-api) +
[live-guide](https://ai.google.dev/gemini-api/docs/live-guide) +
[live-session](https://ai.google.dev/gemini-api/docs/live-session), and OpenAI's
realtime-conversations guide. ⚠ Both surfaces are moving; re-verify before implementing.)*

---

## 1. The split in one paragraph

The web intent tool gets two submodes. **Transcription mode** is everything built so far:
document assembly — speech becomes text segments, shots and selections interleave, corrections
patch, `composeIntent` is the compiler, Enter commits. **Realtime mode** is what `flagship`
gestures at but isn't: a live conversation with a model that *hears you continuously and sees
what you're doing* (audio always; video/images per vendor capability), answers aloud, can be
interrupted — and, at the end, **the model performs the compilation**: it emits a
`submit_intent` tool call whose payload is the prompt (a cleaned-up rendering of the user's
intent), which the channel enriches with image/selection metadata and sends to the session. The
two submodes share their skeleton (gestures, modal states, event stream, wire, trace) and
diverge in exactly three places: **what's retractable, what the preview shows, and who
compiles.**

Honest posture up front: realtime mode is the more interesting future *and* the more
error-prone, more expensive, higher-latency one. It ships as an experimental tier behind
explicit readiness gates (§8); transcription mode remains the default and the fallback — not
just politically but *mechanically* (§5.3: `composeIntent` over the input transcripts is the
safety net when the tool call never comes).

---

## 2. Vendor ground truth

The realtime submode is **optimized for Gemini Live, and runs degraded on OpenAI realtime**.
What the two actually offer (verified, not remembered):

| capability | Gemini Live | OpenAI realtime (gpt-realtime-2) |
|---|---|---|
| audio in | PCM16 **16 kHz** via `sendRealtimeInput{audio}` | PCM16 **24 kHz** via `input_audio_buffer.append` |
| audio out | PCM16 24 kHz (native-audio models) | PCM16 24 kHz |
| **video in** | **JPEG frames ≤ 1 fps** via `sendRealtimeInput{video}` | **none** |
| image in | same path as video (a frame is an image) | `conversation.item.create` + `input_image` (base64 data URL) — **turn-boundary, not stream** |
| text in mid-session | `sendRealtimeInput(text=…)` (3.1) / `send_client_content` (2.5) | `conversation.item.create` + `input_text` |
| manual turn signals (PTT) | disable VAD (`automaticActivityDetection.disabled`) → `activityStart` / `activityEnd` | `turn_detection: null` → `commit` + `response.create` (what realtime-voice.ts does today) |
| automatic VAD | yes, tunable (`silenceDurationMs` ~800 ms default, sensitivities, `prefixPaddingMs`) | yes (`server_vad`) — we don't use it |
| barge-in | `serverContent.interrupted` (clear playback queues) | `response.cancel` (what we send today) |
| input transcription | `inputAudioTranscription: {}` → `serverContent.inputTranscription.text` | `conversation.item.input_audio_transcription.delta/.completed` |
| output transcript | `outputAudioTranscription: {}` → `serverContent.outputTranscription.text` | `response.output_audio_transcript.delta/.done` |
| tools | `toolCall` → `toolResponse`; 3.1 sequential only, 2.5 also `NON_BLOCKING` async (`scheduling: INTERRUPT/WHEN_IDLE/SILENT`) | function calling (standard) |
| **session limits** | **15 min audio-only, 2 min audio+video** (without compression); connection ~10 min | no comparable hard cap documented; cost is the limiter |
| context compression | `contextWindowCompression{slidingWindow, trigger_tokens}` → effectively unlimited session | none (manual truncation) |
| session resumption | `sessionResumption.handle` + `SessionResumptionUpdate{newHandle}` (valid 2 h); `GoAway{timeLeft}` pre-warning | none (reconnect = new conversation) |
| cost telemetry | `usageMetadata.totalTokenCount` + per-modality breakdown per message | usage in `response.done` |
| models | `gemini-3.1-flash-live-preview`, `gemini-2.5-flash-native-audio-preview-12-2025`; 128k ctx (native audio) | `gpt-realtime-2` (also `gpt-realtime`) |

Three design-shaping consequences:

1. **The 2-minute audio+video cap is the realtime submode's tightest constraint.** Video must
   be *lazily engaged* (a "sharing" toggle, not always-on), context compression must be on from
   day one, and `GoAway`/resumption handling is not optional polish — a 10-minute connection
   ceiling *will* hit mid-turn in real use.
2. **The PTT contract survives intact.** Both vendors support manual activity boundaries, so
   Space-to-talk maps 1:1 (`activityStart/End` on Gemini; `append/commit/response.create` on
   OpenAI — the latter is literally today's `realtime-voice.ts`). Automatic VAD becomes an
   optional *hands-free* knob on Gemini later, not a prerequisite.
3. **Image injection has two grades, so it's a capability, not an assumption.** Gemini: shots
   and video ride one stream path. OpenAI: shots inject as turn-boundary `input_image` items;
   the video toggle greys out. The UI reads the capability descriptor (§6) — nothing hardcodes
   a vendor.

Also note the small but real plumbing mismatch: our capture worklet produces 24 kHz PCM
(`REALTIME_PCM_MIME`); Gemini wants 16 kHz in. Either the worklet's `AudioContext` rate becomes
session-configured, or the channel resamples. (Channel-side resample is safer — one client
capture path, vendor adaptation stays server-side where the vendor seam lives.)

---

## 3. The shared skeleton (identical by design)

The user named three parts — user interaction, modal states, "and so forth" — that should be
the same in both submodes. Concretely, all of the following is **one implementation, shared**:

- **Gestures & keymap.** Backtick arms; Space is PTT (mapped per §2.2); D drags a region shot;
  S snaps the viewport; Enter ends the turn; Esc steps out; T tweaks (companion doc §B.5). In
  realtime mode a shot doesn't *just* upload to the trace — it also injects into the live
  session (stream-frame or turn-item per capability) — but the *gesture* and the veil are the
  same code.
- **Modal states.** The `UiMode` model and HUD ring (companion doc §B.4) apply unchanged:
  off/ready/composing/talking/shooting/correcting/tweaking. Realtime mode adds one HUD element
  (the model-speaking indicator already exists as `mm-speaker`) and one state nuance — `talking`
  and model-speaking can overlap briefly during barge-in — but no new modes. Tweak mode is
  *more* valuable in realtime (adjust the app while the model watches via video), and works
  identically.
- **The event stream stays the IR of record — in both submodes.** This is the load-bearing
  decision. In transcription mode the stream is the *compiler input*. In realtime mode
  `composeIntent` is no longer the compiler, but the stream remains the **chronicle**: every
  talk segment, shot, video-share start/stop, selection, model reply transcript, and the final
  tool call are events, so the trace debugger, the turn store, the workbench inspector, and the
  fallback compile (§5.3) all keep working unmodified. New event types needed: `video-share`
  (on/off + why), `model-reply` (promoting what is today a `🔊 …` note to a first-class typed
  event), `intent-submitted` (the tool call, verbatim).
- **The wire.** Same `intent-v1` framing: events chunks, `audio` chunks (already streamed for
  rapid/flagship), attachment frames for shot PNGs. One addition: a `video` chunk kind
  mirroring `audio` (`{kind:"video", id:"vid_1", seq, mime:"image/jpeg"}`) — same envelope,
  same ack discipline, same stats instrumentation for free.
- **Client media capture.** The big reuse win: `ShotTool` already holds a `getDisplayMedia`
  stream for instant frame-grabs. The realtime video source is *the same stream* sampled at
  ≤1 fps into JPEG — one capture grant serves shots and video both. The AudioWorklet PCM path
  is shared verbatim (rapid/flagship use it today).
- **Config layering, error channel, trace store, HUD, panel, selection watcher.** Unchanged.
  The hello still carries the effective config; errors still toast; traces still record every
  stage — realtime turns get *more* trace stages (per-frame usage, tool call), not different
  machinery.

**The rule that keeps reuse honest:** anything that reads or writes the *event stream* is
shared. Anything that interprets the stream as *an editable document* is transcription-only.
That single test decides nearly every "where does this code live?" question.

---

## 4. Where they genuinely diverge

### 4.1 Retraction and correction — the append-only wall

The upstream conversation context is append-only: once audio, a frame, or an image reached the
model, it cannot be unseen. So two transcription-mode affordances don't carry over as-is:

- **The correction micro-pipeline (lasso → V4A patch) is transcription-only.** There is no
  document to patch; there's a conversation. The realtime-native correction is *just talking* —
  "no, the *left* legend" — which the model handles better than any patch pipeline could. The
  lasso/E-mode UI is disabled in realtime mode (correct-mode key inert, HUD shows why on
  attempt). `correct.ts`/`patch.ts` are untouched but unreferenced on this path.
- **Shot retraction becomes advisory, not compositional.** In transcription mode `shot-drop`
  removes the image from the composed prompt — a real deletion from the artifact. In realtime
  mode the ✕ still emits `shot-drop` (the chronicle stays uniform), but its effect is a **text
  injection**: "the user retracted the previous image; disregard it." Cheap, honest, and
  surprisingly effective — but it must be *presented* differently (the thumb gets a
  "disregarded" overlay, not removal), because pretending the model never saw it would be a lie
  the trace would expose. The final `submit_intent` enrichment (§5.2) excludes retracted
  markers from `image_refs`, so the *committed prompt* honors the retraction even though the
  conversation couldn't.

### 4.2 The preview — document vs. ledger

This is the divergence the user called out, and it's real: the transcription preview *is* the
document (segments-as-lines, patch flashes pink/green, thumbs with ✕ that mean deletion). None
of that is true in realtime mode — there is no document until the tool call, and nothing is
editable.

The realtime preview is a **conversation ledger** with three lanes:

1. **Dialogue lane** — rolling user transcript (from `inputTranscription` deltas — this
   plumbing exists) interleaved with model reply transcripts (from `outputTranscription`,
   today's `🔊` notes, promoted to events). Read-only, auto-scrolling, barge-in visible (an
   interrupted reply renders truncated with a ⚡ mark).
2. **Shared-context tray** — what the model can currently see: shot thumbs (with the
   "disregarded" overlay after an advisory drop), a video-sharing indicator (`● sharing 1fps` /
   off), the current selection chip. This is the honest answer to "what does it know?"
3. **Meters** — session budget (time remaining toward the 2-min/15-min caps, connection
   `GoAway` countdown when one arrives), token/cost ticker (`usageMetadata` per message),
   response counter vs. the cap (today's `maxResponses` guard carries over).

Build note: implement both previews from shared primitives (segment row, thumb, chip, meter)
rather than forking `preview.ts` wholesale; but do **not** contort them into one component with
mode flags — the interaction contracts differ (editable vs. read-only), and companion doc §B.3's
lesson applies: forcing one shape breeds complexity. Two thin assemblies over one parts bin.

### 4.3 Compilation — `composeIntent` vs. `submit_intent`

**Transcription mode** (unchanged): `fin` → cached `composeIntent` → Option-C body + meta →
preamble wrap → `sendPrompt`.

**Realtime mode**: the model is told (system instructions + tool declaration) that its job,
throughout the conversation, is to build an accurate picture of what the user wants done to the
app, and that when the user signals completion ("send it", or the user presses Enter — see the
ladder below) it must call:

```jsonc
submit_intent({
  // The prompt to send to the coding agent — the user's intent, cleaned up:
  // deictic references resolved against what the model saw ("this slider" →
  // "the opacity slider in the Controls panel"), corrections folded in,
  // rambling removed. NOT a transcript — a brief.
  "prompt": "string",
  // Which shared images materially support the prompt, by marker, with why.
  // The CHANNEL resolves markers → paths/meta — the model never sees paths.
  "image_refs": [{ "marker": "shot_2", "why": "shows the misaligned legend" }],
  // What the model believes is still ambiguous (rides the prompt as a note —
  // the receiving agent decides whether to ask or proceed).
  "open_questions": ["string"]
})
```

The channel then does what it already knows how to do: excludes retracted markers, resolves
markers to blob paths, attaches `shot_n`/`shot_n_info` meta (or the compact style — companion
doc §B.3 applies to both submodes), wraps with the **same** `prompt-context.ts` preamble
(tab/source/selection sections, shared verbatim), records the tool call as a trace stage
(`ir: "model-composed"`), pushes `lowered-prompt`, and `sendPrompt`s. The model composes the
*body*; the channel still owns *context, attachment plumbing, and commitment*. Symmetric,
auditable, and the debugger can diff "what the model heard" (input transcripts) against "what
it submitted".

**The fallback ladder** (the part that makes realtime shippable at all):

1. ~~User says "send it" → model calls `submit_intent` on its own → commit.~~ *(Superseded
   July 2026 — §11: submit is commit-gated. The model may never fire on its own; step 2's
   message is the only trigger.)*
2. User presses **Enter** → channel injects a text nudge ("the user pressed send — call
   `submit_intent` now with what you have") and awaits the call with a drain timeout
   (analogous to today's `REALTIME_DRAIN_TIMEOUT_MS`).
3. Timeout / malformed call / session already dead → **`composeIntent` over the accumulated
   input transcripts** — the transcription compiler, running on the chronicle that was
   maintained all along — produces the prompt, marked in the trace as `fallback: true`, with a
   loud toast saying the model didn't compose. The turn *never* dies from model flakiness.
4. Esc → cancel, lowers to nothing (both submodes, unchanged).

That ladder is why the event stream stays the IR of record in realtime mode: step 3 is free
because §3 refused to give it up.

---

## 5. Session lifecycle (realtime submode)

Per-thread, like today's flagship session, with three additions Gemini forces:

- **Open** at thread-open (handshake hides in the arm→talk gap — same trick as rapid).
  Session config: manual activity (VAD off), input+output transcription on, tools =
  [`submit_intent`], context compression on (`slidingWindow`), system instructions = the
  composer persona + **initial context seeding**: the same pre-warmed tab/source preamble the
  transcription preamble uses, injected as initial history — the model starts the conversation
  already knowing which app and which source tree it's looking at. (On Gemini 3.1 this must go
  through `initial_history_in_client_content`; on 2.5 via `send_client_content`.)
- **During**: audio streams during PTT windows; video frames stream only while the share
  toggle is on; shots inject per capability; selection changes (companion doc §B.3,
  selection-as-event) inject as text ("the user selected: …"). `GoAway{timeLeft}` → HUD meter
  turns amber, channel captures the latest `SessionResumptionUpdate.newHandle` and reconnects
  with `sessionResumption.handle` — the *thread* survives the connection.
- **End**: tool call or ladder (§4.3), then close. `onClose` teardown extends today's (S2)
  pattern: abandoned turns close the upstream and lower to nothing.

---

## 6. The vendor seam

Generalize the pattern `realtime.ts`/`realtime-voice.ts` already use (injectable socket
factories) into one interface both vendors implement:

```ts
interface LiveSession {
  readonly capabilities: LiveCapabilities;
  appendAudio(segment: number, pcm: Uint8Array): void;
  activityStart(segment: number): void;        // no-op where implicit (OpenAI: first append)
  activityEnd(segment: number): void;          // Gemini: activityEnd · OpenAI: commit + response.create
  injectImage(marker: string, jpeg: Uint8Array): void;   // stream-frame OR turn-item, per capability
  appendVideoFrame(seq: number, jpeg: Uint8Array): void; // throws if !capabilities.video
  injectText(text: string): void;              // selection changes, retraction advisories, nudges
  cancelActiveResponse(): void;                // barge-in
  requestSubmit(): void;                       // the Enter nudge (§4.3 step 2)
  drain(timeoutMs: number): Promise<number[]>; // same contract as today
  close(): void;
  // handlers: onUserDelta/onUserFinal (feed the chronicle exactly like today),
  // onReplyDelta/onReplyFinal, onReplyAudio, onToolCall(submit_intent payload),
  // onInterrupted, onUsage(tokens), onGoAway(msLeft), onError(message, segment?)
}

interface LiveCapabilities {
  video: boolean;                      // Gemini: true (≤1fps) · OpenAI: false
  imageInjection: "stream" | "turn-item";
  resumption: boolean;                 // Gemini: true · OpenAI: false
  contextCompression: boolean;
  inputRateHz: 16000 | 24000;          // drives channel-side resample
}
```

- **`GeminiLiveSession`** is the reference implementation (the submode is optimized for it).
- **`OpenAiLiveSession`** is today's `realtime-voice.ts` refactored under the interface +
  `input_image` injection + the `submit_intent` tool declaration. Video toggle greyed.
- The capability descriptor rides to the client (hello ack / a `capabilities` push) so the UI
  gates the video toggle and the tray copy without vendor knowledge.
- Keys: `GEMINI_API_KEY` joins `OPENAI_API_KEY` in the channel process env (`.env.dev` slot,
  same keyless-is-loud posture, same stale-key hint pattern in the error channel).

Config: the submode is the top-level axis (it *implies* the composer):

```
submode: "transcription" | "realtime"     // default: transcription
// realtime fine fields (tier "live" expands to these):
liveVendor: "gemini" | "openai"           // default: gemini
liveModel:  string                        // default: gemini-3.1-flash-live-preview
liveVideo:  boolean                       // default: false (the 2-min cap is real)
```

The tier ladder gains one rung: **`live`** (`submode:"realtime"` + the defaults above).
`flagship` stays as-is — the OpenAI voice *veneer* over transcription mode remains a valid,
cheaper product (spoken acks + answers with user-composed prompts) and is not deprecated by the
realtime submode. This supersedes the companion doc's `composer: "user"|"model"` sketch: the
composer follows from the submode; it isn't independently configurable.

---

## 7. Code reuse map

| module | disposition |
|---|---|
| `intent-pipeline/engine.ts`, `types.ts` | **shared** — + `video-share`, `model-reply`, `intent-submitted` events |
| `intent-pipeline/keymap.ts` | **shared** — E (correct) capability-gated off in realtime |
| `composeIntent` | **shared** — compiler (transcription) *and* fallback compiler (realtime §4.3) |
| `correct.ts`, `patch.ts` (both sides) | **transcription-only** — untouched |
| `multimodal/shot.ts` | **shared** — capture stream doubles as the video source |
| `multimodal/audio.ts` (worklet) | **shared** — rate adaptation is channel-side |
| `multimodal/preview.ts` | **split** — shared primitives, two assemblies (document / ledger §4.2) |
| `multimodal/speech.ts` (player) | **shared** — barge-in ducking unchanged |
| `protocol.ts` / `frame.ts` | **shared** — + `video` chunk kind |
| channel `intent-v1.ts` | **split at the processor** — hello's `submode` picks: today's path, or a sibling realtime processor sharing the chronicle/trace/attachment helpers |
| channel `realtime.ts` (STT session) | **transcription-only** (rapid/premium) — unchanged |
| channel `realtime-voice.ts` | **refactored** into `OpenAiLiveSession` under the seam (§6); flagship keeps working through it |
| channel `prompt-context.ts` | **shared** — preamble wraps both compilers' output; also seeds the live session (§5) |
| errors, traces, turn-store, HUD, config layering | **shared** — turn-store caveat: a recovered realtime turn can't revive its dead session; recovery degrades to the fallback compiler with a note |

---

## 8. Readiness: what must be true before realtime leaves "experimental"

The user's skepticism is warranted — price it in as gates, measured in the workbench against
trace data, not vibes:

- **G0 · API spike (before any pipeline work, ~half a day per vendor).** Hold a Gemini Live
  session: PCM in at 16 kHz, three JPEG frames, manual activity signals, input+output
  transcription on, `submit_intent` declared. Measure: does the model ground "this slider"
  against a frame? Tool-call arrival rate when asked to submit (n=20)? End-to-end
  Enter→tool-call latency? Token cost of a 90-second turn with video on vs. off? Same protocol
  on gpt-realtime-2 minus video.
- **G1 · Compile reliability.** Over a fixture set of conversations: `submit_intent` fires on
  ladder steps 1–2 ≥ 95 % of turns; the step-3 fallback produces a usable prompt 100 % of the
  time (it must — it's `composeIntent`).
- **G2 · Session robustness.** A 10-minute composing session survives a `GoAway` reconnect
  without losing the thread; the 2-minute a+v cap is either never hit (lazy video) or degrades
  loudly (video off, session continues).
- **G3 · Cost ceiling.** Median cost per realtime turn ≤ N× the rapid-tier turn (pick N after
  G0; if it's >10× with video on, lazy-video defaults get stricter).
- **G4 · The actual question.** Side-by-side in the workbench on identical tasks: does the
  model-composed brief beat the user-composed prompt on downstream agent success (right
  file/tab first action — same metric as the companion doc's prompt-style bake-off)? If it
  doesn't beat transcription mode, realtime stays a toy no matter how cool the demo is.

---

## 9. Work plan (extends the companion doc's table; RT = realtime track)

| # | What | Size | Depends on |
|---|---|---|---|
| **RT0** | ✅ **Done (July 2026)** — Gemini spike green end-to-end; see §10 below and `archive/gemini-live-spike.mjs`. | S | — |
| **RT1** | ✅ **Done** — vendor seam `LiveSession`/`LiveCapabilities`/`SubmitIntentCall` in `aiui-claude-channel/src/live-session.ts`; OpenAI engine is a **separate** `openai-live.ts` under the seam (borrowed from, not a refactor of, `realtime-voice.ts` — flagship left untouched by design; `submit_intent` tool + `input_image` turn-items + tool-call drain added). | M | RT0 |
| **RT2** | ✅ **Done** — `gemini-live.ts`: manual-VAD setup per §5, `sessionResumption`+sliding-window compression, `usageMetadata`→`cost.ts` (`usageFromGeminiLive`, google), GoAway surfaced. Client 24 kHz is sent `audio/pcm;rate=24000` (**no resampler** — live-verified the API accepts it); the window-open-with-audio rule enforced by a pure `WindowOrderingGuard`. Reconnect-on-GoAway deferred (handle captured, not yet re-dialed). | L | RT1 |
| **RT3** | Client media: `video` chunk kind, ShotTool-stream sampling at 1 fps, share toggle + `video-share` events, capability gating in the UI. | M | RT1 |
| **RT4** | ✅ **Done** — realtime processor branch in `intent-v1.ts` (`submode:"realtime"`): chronicle accumulation, live injections (labeled shots/video), `submit_intent`→`resolveSegments` (shot metadata re-attached via a `renderShotBlock` mirror of engine.ts), the nudge→drain→`composeIntent` fallback ladder, and the pinned trace stages (`live open`/`live label shot_N`/`live nudge`/`live tool call`/`live resolved`/`live fallback`/`live reply`). Selection injected only into the fin preamble (not mid-session), corrections ignored (patchless echo + note). | L | RT1, WP3 (selection-as-event) |
| **RT5** | Ledger preview (§4.2) from shared primitives; HUD meters (session budget, cost, response cap). | M | RT3, WP2 (UiMode) |
| **RT6** | Gate evaluation G1–G4 in the workbench; decision: promote `live` tier out of experimental, or park with findings recorded here. | M | RT2–RT5 |

Sequencing note: WP2 (UiMode) and WP3 (selection-as-event) from the companion doc are genuine
prerequisites for RT5/RT4 respectively — the tracks interleave rather than queue. RT0 can start
immediately and should: every sizing decision above gets sharper with G0 numbers in hand.

---

## 10. RT0 results (July 2026 — Gemini spike, all verified live)

Working artifact: `archive/gemini-live-spike.mjs` (raw WebSocket, no SDK; `GEMINI_API_KEY` in
`.env.dev`; the pasted capabilities guide the user supplied is the reference). Findings that
bind the RT1/RT2 design:

1. **Go raw WebSocket, not `@google/genai`.** SDK 2.10.0's wire transformer silently DROPS
   `realtimeInputConfig` from the setup frame (present in the types, absent on the wire), which
   makes manual VAD impossible through it — activity signals then die with `1007 Precondition
   check failed`. Raw `BidiGenerateContent` (v1beta) works and matches how the channel already
   speaks to OpenAI realtime (injectable socket factory, exact frames, testable).
2. **The drag problem is solved by manual VAD.** With `automaticActivityDetection.disabled`,
   the model stayed silent through a deliberate 2 s mid-window pause and responded only after
   `activityEnd`. The turn is OURS to end — a drag's silence is a non-event. (OpenAI mirror:
   `turn_detection: null` + explicit `response.create`; bonus, verified in docs: OpenAI's
   turn detection can also be changed MID-SESSION via `session.update`.)
3. **Undocumented window rule: a manual activity window must open with AUDIO.** `text`-first
   inside a window → 1007; once audio has opened the window, `text` and `video` frames
   interleave freely. Natural fit — the modality's mic streams continuously — but RT2 must
   respect the ordering (never emit a label/frame into a window before any audio has flowed).
4. **The Enter nudge works**: bare `realtimeInput.text` OUTSIDE any activity window is a legal,
   immediately-answered turn — the fallback ladder's step-2 mechanism, verified.
5. **Label-correlation works, metadata withheld.** Each deliberate image is preceded by a text
   label (`[image s1]`) and sent as `realtimeInput.video` (PNG accepted). The model referenced
   ids in speech ("the red screenshot [image s1]") and returned bare ids in the function call.
   Element/cell metadata never goes to the live model — the channel keeps it keyed by label and
   re-attaches it (the existing `<screenshot>` render) when resolving the function call.
6. **The function-call shape is exactly the design**: `submit_intent` returned
   `segments: [{text}, {image:"s1"}, {text}, {image:"s2"}, {text}]` — cleaned-up prose
   interleaved with refs, positioned correctly. One run answered with a clarifying question
   instead (sensible; the spike's audio contradicted its text) — the nudge resolved it; forced
   function-calling (`toolConfig.functionCallingConfig.mode: ANY`) is setup-time-only on Live,
   so the nudge, not forcing, is the mechanism.
7. **Costs flow**: `usageMetadata` per turn with AUDIO-modality breakdown — cost.ts's Gemini
   support plugs straight in.
8. **OpenAI re-verified** (docs): `gpt-realtime-2` takes images via `conversation.item.create`
   + `input_image` (pair the label as `input_text` in the same item), NO video; items never
   auto-trigger responses; tools declared via `session.update`, calls arrive in `response.done`.

Design deltas vs §4.3: the `submit_intent` schema is now `segments[]` (interleaved
`{text?, image?}`), not `{prompt, image_refs}` — the spike proved models emit it naturally and
it preserves position without post-hoc splicing. Video frames stay unlabeled ambient context;
only deliberate shots (drag or S) get labels and are referenceable.

---

## 11. Commit-gated submit (decided July 2026)

*(Addendum — supersedes §4.3's ladder step 1. Landed with RT4, July 2026.)*

The user's call: the session instructions must describe the **actual situation** — a human and
the model jointly composing an instruction for a coding agent; the human dictates by voice and
shares screenshots and on-screen context; the model's final output is the clear, composed
instruction (referencing the images) — and the model must **not** fire `submit_intent` on its
own judgment. Not on a spoken "send it", not on conversational momentum. The single trigger is
an explicit, client-originated text message the channel injects into the conversation when the
human commits the thread (Enter → `fin`). That message already existed as the step-2 "Enter
nudge" (`LIVE_NUDGE_TEXT`, `aiui-claude-channel/src/live-session.ts`); it is now the **commit
sentinel** — the only authorized trigger, not a fallback prod.

Landed:

- **One authoritative persona** — `LIVE_COMPOSER_INSTRUCTIONS` (`live-session.ts`, beside the
  sentinel), shared by both engines; the per-engine `GEMINI_LIVE_INSTRUCTIONS` /
  `OPENAI_LIVE_INSTRUCTIONS` duplicates are gone. It describes the co-composition situation and
  **embeds the sentinel verbatim** (template-literal interpolation, so the gate text can never
  drift from the message that springs it), with the plain rule: call `submit_intent` ONLY after
  that exact message arrives; never earlier, even if asked aloud to send.
- The processor (`intent-v1.ts`) passes the shared persona explicitly at open and records it on
  the `live open` trace stage — the trace shows the instructions the session actually ran under.
- The ladder loses its step 1: fin → sentinel (step 2, mechanism unchanged) → drain →
  `composeIntent` fallback (step 3, unchanged) → Esc/cancel (step 4, unchanged).

Deliberately unchanged (specced, not re-plumbed): a model that fires early despite the
instructions is still tolerated — `drainToolCall` buffers the call and fin consumes it
(forgiving beats fatal; the trace's `live tool call` stage timestamps the misbehavior). The
pinned trace-stage names (`live nudge` et al.) and the seam method (`nudgeSubmit`) keep their
names — the debug-ui pins the labels — even though the nudge is now the gate. The flagship
veneer's `DEFAULT_VOICE_INSTRUCTIONS` (`realtime-voice.ts`) was rewritten to the same honest
framing (the human is dictating for a coding agent; the veneer never restates the dictation),
still toolless — flagship's composition remains `composeIntent`'s.
