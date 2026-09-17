# The oracle and GPT-Live — what changes, what it unlocks, how to build it

Status: **RESEARCHED and BUILT, 2026-09-15.** Everything below was checked against OpenAI's
live docs (the `.md` versions of the six GPT-Live guides plus the WebRTC / WebSockets /
server-controls / cost pages) and against the real API with this repo's `OPENAI_API_KEY`,
using the probe in [`exploration/live-probe/`](../../exploration/live-probe/). Numbers marked
*measured* come from those runs; everything else is the vendor's documentation. The package
and demo the document argues for now exist — see [§10](#10-what-was-built).

The oracle today is `@habemus-papadum/aiui-oracle` — a WebRTC session from the browser to
the **Realtime API** (`gpt-realtime-2.1`) with the app's controls projected as tools, plus its
embedding in the intent panel ([the oracle doc](../../packages/aiui-oracle/docs/oracle.md)).
GPT-Live (`gpt-live-1`) is a different kind of model with a different API, and the short
version of this document is: **it is not a superset, it is a re-partitioning** — the voice
model gives up tools and reasoning in exchange for full duplex and a backend that can think
for as long as it likes. That trade is exactly the one aiui wants to make, because the
backend can be Claude Code.

## 0. The three questions, answered in one screen

**What are the major differences?** Realtime is *one brain*: a single model that listens,
reasons, picks tools and speaks, turn by turn, under a VAD you configure. GPT-Live is *two
parts*: a full-duplex voice model that only converses and decides *when to ask for help*,
and a backend — OpenAI's Responses models or your own service — that reasons and runs
tools with no latency budget. Consequences: the session has almost no mutable config, tools
move off the voice model, images move off the voice model, turn-taking config disappears,
the event model becomes fragment-based, billing becomes flat per second of wall-clock, and
the browser no longer holds an ephemeral key (there are none) — a server does the SDP
exchange.

**What does it unlock?** A voice front end that stays conversational while a *minutes-long*
task runs behind it, with progress spoken on the way. For aiui specifically: the backend can
be the **channel process**, which already routes to page tools and already talks to the
Claude Code session — so "ask the app why it is slow" can become a delegation to Claude
Code, with the answer coming back as speech. Also: overlapping requests while a task runs
(measured), UI context injected as quiet facts instead of prompt rewrites (measured), two-hour
sessions with automatic compaction, session recording and forking, and a transcript side
stream for speculative work.

**How do long interactions work?** A delegation is a *ticket*, not a call. The voice model
hands you an id and keeps talking; you stream back progress (`session.thinking.append` for
quiet facts, `session.commentary.append` for things to say aloud), each under 500 tokens,
and finish with the result whenever it is ready — 25 seconds later in our probe, minutes
later in principle. The conversation is not blocked: the user asked a second question
mid-task and got it answered inside the first task's window. What you own: the task table,
correction handling, cancellation, and the decision to close the voice session while the
backend keeps working (idle time bills $0.05/min).

## 1. The oracle today, in the terms that matter for the comparison

- **Transport and auth.** Browser WebRTC to `POST /v1/realtime/calls` with an ephemeral
  `ek_` minted by a key source (paste key, dev key, or the channel's `/intent/oracle/mint`).
  Events on the `oai-events` data channel; reply audio on a track.
- **Session config.** A mutable Realtime session: instructions (woven from `app` /
  `context` / `stance` slots, refreshed only when the text moved), the tool array (wholesale
  `setTools`), `audio.input.turn_detection` (`semantic_vad`, `eagerness: low` in the panel),
  `noise_reduction`, `reasoning.effort` on the voice model, voice/speed, all reconciled
  against `session.updated` with a drift check and two params widgets.
- **Turn machinery.** The first-reply echo window (`interrupt_response: false` until the
  first reply finished), greeting-as-priming, `shush` = `response.cancel` +
  `output_audio_buffer.clear`, `output_audio_buffer.*` as the end-of-speech signal.
- **Tools.** One typed `set_<control>` per control, one per action, `report`; executed in
  the page from `response.done` items (only `completed` responses execute), results
  returned as `function_call_output` + `response.create`. In the panel: the page's tools
  via the page-tools registry, the panel's bar, and three file tools that cross into the
  channel over `/intent/oracle/tool`.
- **Rich input.** `sendText` / `sendImage` as `conversation.item.create` (screenshots and
  selections ride in with the lowered prompt's own renderers, `respond: false`).
- **Lifecycle and cost.** Park is free (mic gated, connection open, $0 while idle); the
  vendor caps a session at about 60 minutes; cost is per token with an ~8× audio/text gap,
  re-billing the instructions as input on every turn.
- **Ledger.** Item-shaped: `heard` / `said` / `tool-call` / `tool-result` / `response` with
  usage / `reply-audio` / `speech`, grouped into turns by `opensTurn`.

## 2. What GPT-Live is

Two cooperating parts, one session:

- **The voice model** (`gpt-live-1`) listens and speaks *at the same time* (full duplex),
  produces backchannels ("mm-hmm", "Okay, hang on"), handles interruptions itself, and
  follows a short prompt whose most important section is a **delegation policy**: what the
  backend can do, when to delegate, when not to. It cannot call tools and cannot see images.
- **The backend** does everything else. Two modes, fixed per session:
  - **Responses delegation** — OpenAI runs a Responses model you configure
    (`delegation.responses.model` with `instructions`, function `tools`, `web_search`,
    `tool_choice`, `parallel_tool_calls`, `reasoning`, `service_tier`, `max_output_tokens`).
    Live supplies the conversation context. Your custom functions still execute in *your*
    code: the call arrives inside a `response.event` envelope, you answer with
    `response.item.create` (`function_call_output`) and `response.create`.
  - **Client delegation** — Live emits `session.delegation.created` with an opaque
    `delegation.id` and `offset_ms`, **and nothing else** — no task text, no arguments. You
    work out what the user wants from the transcript deltas you have been collecting, run
    whatever you like (a model, an agent, Claude Code), and stream results back by id.

Three append events feed the voice model during a session, in either mode, all plain
strings capped at **500 tokens** each, all carrying a `delegation_id` (`null` for
session-wide):

| Event | The model treats it as |
| --- | --- |
| `session.instructions.append` | trusted directives — can interrupt speech; use for "stop", disclosures, greetings |
| `session.thinking.append` | quiet facts — not spoken on arrival, used for later answers |
| `session.commentary.append` | something to say aloud, paraphrased |

Each is acknowledged (`…appended` with `client_event_id`, `start_ms`, `end_ms`) once the
content has been *injected* — not when it has been spoken.

Connections: **WebRTC** for browsers (audio on tracks, events on the `oai-events` data
channel; the session is created by `POST /v1/live/sessions` with the SDP offer and the
project API key — **there are no ephemeral tokens in GPT-Live**), a primary **WebSocket**
for servers (audio as base64 PCM16 in JSON events), and a **sideband** WebSocket
(`/v1/live/sessions/{id}/attach`) for a server to observe and steer a WebRTC or SIP
session while the browser keeps the audio.

## 3. The major differences, axis by axis

| Axis | Realtime (`gpt-realtime-2.1`, the oracle today) | GPT-Live (`gpt-live-1`) |
| --- | --- | --- |
| Brain | one model: speech + reasoning + tool choice | voice model converses; backend reasons and runs tools |
| Turn-taking | half duplex under configurable VAD; commits, `response.create`, barge-in truncation | full duplex; the model decides when to speak; no VAD, no commits, backchannels built in |
| Tools | `session.tools` on the voice model; calls in `response.done` | none on the voice model; Responses-mode functions in `delegation.responses.tools`, or anything in client mode |
| Reasoning | `reasoning.effort` on the voice model (costs voice latency) | none on the voice model; backend reasons at any effort, off the critical path |
| Images | `input_image` items to the voice model | not accepted by the voice model; send to a vision backend |
| Mutable config | instructions, tools, VAD, noise, speed, effort via `session.update` + echo | only `delegation.responses.*`; instructions are *append-only*; model / voice / audio / store frozen |
| In-session context | `conversation.item.create` (text, images), instructions rewrite | three append events, 500 tokens each; `input` history (≤128 msgs, ≤8192 tokens) at start only |
| Transcripts | per-item `…transcription.completed`, `response.output_audio_transcript.done` | fragment deltas with session-timeline `start_ms` / `end_ms`; no item ids, no turn boundaries |
| End of speech | `output_audio_buffer.stopped` (WebRTC) | no event; track playback yourself |
| Usage | tokens per `response.done`, modality split | `session.usage.updated { seconds }` snapshots (~every 15 s); backend tokens in nested `response.completed` |
| Billing | per token: audio in $32/M, out $64/M, cached $0.40/M; idle costs nothing | **$0.05/min flat, per second, silence included**; +15 s billed at WebRTC creation (credited); backend at Responses prices |
| Session length | ~60 min | `expires_at` ≈ **2 h** (measured 7.2 ks); compaction at 90 % of 128 k keeps instructions + 8 k recent |
| Browser auth | ephemeral `ek_` (mint server-side, single-use) | project key on a server that exchanges the SDP; CORS on `/v1/live/sessions` is open (verified), so a *pasted* parent key can still go direct |
| Server access | sideband by `call_id` | sideband by `session.id`, WebRTC/SIP sessions (WS-primary attach answered 404 in our probe) |
| Persistence | none | `store: true` → 30-day stereo WAV recording, `fork` into a new session |
| Voices | marin, cedar, … | marin default + 12 new (quartz, ripple, vesper, willow, stone, gleam, meridian, bossa, tempo, beacon, delta, cinder) |
| Rate limits | RPM / TPM | concurrent sessions (25 at tier 1) |

Two of these deserve a sentence each, because they invert decisions the oracle codified:

- **Park is no longer free.** A muted Live session bills $3/hour. The oracle's "park on
  page-switch, resume on return, $0 while parked" becomes *close and re-seed*: keep your own
  transcript (client mode makes you keep it anyway), close after the idle timeout, and on
  resume create a new session with the relevant history in `input` (≤8192 tokens), or fork a
  stored session. Reconnect costs ~0.6 s over WebSocket (measured) plus the WebRTC handshake
  in a browser.
- **The echo machinery has no object.** `firstReplyGuard`, greeting-as-priming, `semantic_vad`
  eagerness, `far_field`, the interrupt pair — all of it manipulates a VAD that Live does not
  expose. Whether a laptop mic hearing the speakers still confuses a full-duplex model is
  the first thing the browser demo must measure; the browser's echo canceller is still the
  only defence.

## 4. What we measured

Six sessions over the primary WebSocket, synthesized speech as the user (`gpt-4o-mini-tts`
at 24 kHz PCM, paced in real time, silence in between). Wall-clock unless noted.

| Quantity | Measured |
| --- | --- |
| Socket open → `session.started` | 0.5–0.9 s (four backends tried; all accepted: `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.4-mini`) |
| User stops speaking → `session.delegation.created` | 0.49 s, 0.72 s, 0.80 s, 0.54 s (four delegations); `offset_ms` lands on the last word |
| Voice model's own acknowledgement after delegating | 0.15–0.2 s ("Okay. Hang on." / "Sure, adjusting it now.") |
| `session.commentary.append` → first spoken word of it | 0.52 s, 0.67 s, 0.58 s |
| Append acknowledgement (`…appended`) | 0.7 s after send, i.e. *after* speech had already started |
| `session.thinking.append` with `delegation_id: null` → answered a question from it without delegating | yes; 0.9 s from end of question to first word ("It's set to 0.8.") |
| Client-mode round trip, end of utterance → "Done." with a 1.5 s simulated tool | 2.55 s total (≈1.0 s platform overhead) |
| Responses mode (terra, `effort: low`): delegation → function call item | 0.77 s (8 reasoning tokens) |
| Responses mode: tool result → `response.completed` → new response with text → "Done." | 0.24 s, then 0.8 s, spoken 1.6 s after the result; **2.9 s** end of utterance → "Done." |
| Backend tokens per delegation (terra) | 1112 input / 28 output — Live supplies instructions + tools + transcript |
| 25-second client task with a second question at +9 s | both delegations served; progress narrated; final 60-word result spoken faithfully in 14 s |
| Oversize append | `error invalid_value "Context append text must not exceed 500 tokens."` |
| Unknown delegation id | `error "Unknown client delegation."` (code `null`) |
| Output audio | a **continuous** stream, silence included (31.2 s of audio for a 31 s session) — "is it speaking" must come from transcript deltas or an energy gate |
| Input transcript lag behind audio | ~1.2 s |
| Voice usage | 14 s / 49 s / 11 s / 31 s per session — $0.012–0.041 each |

Observations that shape the design:

- **The voice model paraphrases and compresses.** "Done. The frequency is now 5 hertz."
  came out as "Done. It's set to five hertz."; the backend's "Frequency set to 5 hertz."
  became just "Done." Exact wording needs `session.instructions.append` (the disclosure
  pattern). The oracle persona's "say only *done*" survives as a prompt line and works.
- **Quiet appends are narrated when the prompt asks for it.** Our live prompt said "if the
  backend says it is still working, tell the user briefly and wait"; a `thinking.append`
  progress note was promptly spoken as "Still checking. I'm reading the renderer…". Without
  that line the doc's description (not spoken on arrival) presumably holds. Either way the
  prompt, not the event type, decides what the user hears.
- **Silence stays silent.** Between progress notes the model said nothing — no filler. A
  long task with no appends is a long quiet; that is on us to fill (or not).
- **Overlapping delegations just work.** The second question opened a second ticket while
  the first was open; the model merged the second answer and the first task's progress into
  one natural utterance.
- **Delegation fires before the audio even ends** (`offset_ms` ≤ utterance end): the model
  commits to delegating on the last word, so the 0.5–0.8 s is mostly network and pipeline.

## 5. What it unlocks for aiui

**The channel as the backend.** Client delegation wants a server that keeps the transcript,
decides what the request means, runs it, and streams results. aiui already has that server:
the channel process holds the page-tool directory (`page_tools_call` routes to the right
tab), holds the vendor keys, and holds the stdio pipe into the Claude Code session. So:

- *fast path* — a small Responses call (`gpt-5.6-luna` or `gpt-5.4-mini`, low effort, ~1 s)
  over the tab's page tools, executed through the directory, result appended as commentary.
  Same shape as the oracle's tool loop, moved server-side.
- *deep path* — the delegation becomes a **channel push into Claude Code** (`kind: "prompt"`:
  the transcript window, the `<tab …/>` record, the delegation id). This passes the
  channel-wakeups rule — it is a real user request the model can act on. Claude Code works
  with everything it has (page tools, the DevTools MCP, the repo, screenshots it takes
  itself) and reports back through **new MCP tools on the channel**: `oracle_say(text,
  delegationId?)` → commentary, `oracle_note(text)` → thinking, `oracle_steer(text)` →
  instructions. The skill tells it to narrate at milestones and to keep each call under 500
  tokens.

That turns the oracle from "voice over the app's controls" into "voice over the agent" — the
spoken briefing arrives in the Claude session, and the answer comes back as speech while the
user keeps working. It is the intent tool's loop with the typing removed.

**Both hosts behave the same.** The plain-page host and the extension both already keep a
WebSocket to the channel; the browser relays data-channel events (delegation created,
transcript deltas) up and appends down. The sideband attach (`/attach`) would let the channel
act without the tab in the loop — it is documented for WebRTC/SIP sessions and our WebSocket-
primary attempt got a 404, so it is verified in the browser demo, not assumed.

**UI context as quiet facts.** The oracle's `context` slot (the `<tab …/>` record, the
selection, the route) becomes `session.thinking.append` with `delegation_id: null` on
navigation and selection — 500 tokens is plenty for a tab record, and we measured the model
answering from it without a round trip. Screenshots go to the backend (Claude Code can take
its own; a pasted one rides the delegation push), never to the voice model.

**Two-hour sessions, compaction, recording.** A conversation that outlives the 60-minute
Realtime cap, with the vendor summarizing old history; `store: true` yields a stereo WAV
(input left, output right) — a research artifact for prompt lowering, and `fork` gives
"resume this conversation" for free.

**Transcript fragments as a side stream.** The channel sees the user's words 1–2 s before
the delegation event; it can start reading the file the user is talking about, highlight the
control they named, or run a guardrail, before being asked.

## 6. Designing for long interactions

The unit is a **task**, keyed by `delegation.id`, and the app owns it end to end:

```
delegation.created ─▶ task { id, revision, transcriptWindow, backend, status, startedAt }
      │
      ├─ decide: fast (page tools via a small model) │ deep (Claude Code) │ clarify (instructions.append)
      ├─ progress: thinking.append (quiet) / commentary.append (spoken), ≤500 tokens, at milestones
      ├─ corrections: a new delegation that revises an open task → bump revision, cancel or re-scope
      └─ result: commentary.append (chunked ≤500 tokens); the voice model paraphrases
```

Rules that fall out of the probes and the docs:

1. **Progress is your job.** The model will not fill silence. For a Claude Code task, the
   channel should speak something at delegation time ("I've handed that to the agent"),
   relay Claude's milestone notes as they come, and say when the task is done — all through
   the same three appends. Whether progress is *heard* or *kept quiet* is a prompt decision
   on the live side (see §4), so the persona should say when to narrate.
2. **Results are ≤500 tokens per append, paraphrased.** Long answers get chunked into
   coherent pieces (the docs: "buffer only enough to form a coherent chunk"); anything that
   must be exact goes as an instruction.
3. **Interruption ≠ cancellation.** "Stop" stops speech; the backend keeps running. A
   spoken "never mind" is a new delegation the app interprets as cancel — and for Claude
   Code, the channel cannot abort a running turn; it can queue a message that lands when the
   turn ends. Open question: whether Claude should poll an `oracle_status` tool between
   steps so a cancel is honoured mid-task.
4. **Keep the transcript and the task state yourself.** Live's history is compacted; the
   delegation event carries no text; a replacement session needs `input` seeded from your
   record and must not repeat completed actions.
5. **Close the voice session when it goes idle; the backend need not stop.** The oracle's
   2-minute idle park becomes an idle *close*; the result of a still-running Claude task
   lands in the panel (the mind strip, a toast) and, if the user comes back, in a new
   session seeded with the transcript plus the result, opened with a commentary append.
6. **Corrections mid-task are normal.** The probe's second question was independent; a
   correction ("no, the *amplitude*") should map onto the open task's revision, and late
   results for a superseded revision must be dropped, not spoken.

## 7. One component, two, or a base?

**Build a separate `aiui-live` package. Do not refactor an `OracleBase` out first.**

The reasons are structural, not cosmetic. The engine of `aiui-oracle` (`session.ts`) is
almost entirely about things Live does not have: the wire session with `session.update`
reconciliation, the echo window, VAD tuning, `response.done`-gated tool execution,
item-based injection, token usage. Its ledger vocabulary (`heard` / `said` / `response` /
`reply-audio`) does not describe fragment transcripts, delegation tickets or seconds of
usage. Its key sources mint ephemeral secrets that do not exist in Live. Forcing both behind
one class would produce a base with two disjoint halves and a lot of capability flags —
the thing the transport seam was deliberately designed to avoid.

What genuinely carries over, and how:

| From `aiui-oracle` | In `aiui-live` |
| --- | --- |
| `aiui-tools.ts` (typed `set_<control>` / action / `report` projection; JSON-schema synthesis) | reused as-is for Responses-mode `tools` and for the fast path's tool list — import it (or lift it into a tiny shared module later) |
| `PromptSlots` / `weaveInstructions` | the `app` and `stance` slots become the live prompt (persona + delegation policy); `context` becomes `thinking.append`; the persona text is rewritten for full duplex |
| `KeySource` (paste key → dev key → mint) | paste key and dev key survive (direct `POST /v1/live/sessions`, CORS is open); "mint" becomes a **session broker** route on the channel / Vite plugin that does the SDP exchange and returns `session.id` + answer |
| widgets: control strip, mind, viewer, usage | same *shape*, new model: captions as two revisable rows with timeline ms, a task table, a seconds meter, a status area for backend progress separate from captions |
| `cost.ts` | seconds × rate for voice; backend tokens through the same genai-prices path |
| the panel lanes (`lanes/oracle.ts`) | the tool-source rule (eye when on an app, else the last app) survives as *which tab the delegation is about*; execution moves to the channel |

What is new and has no counterpart: `LiveSession` (WebRTC in the browser; WebSocket in
node for probes and the sideband), the append/ack bookkeeping with `client_event_id`, the
task table, the delegator interface (`localTools` / `responses` / `claudeCode`), the idle
close + re-seed lifecycle, the channel's `/live` routes and the three MCP tools.

Revisit "one component" only if, after the live one exists, the two packages' widget
layers turn out to be byte-similar — then extract widgets, not engines.

## 8. Demos to build next, and what each measures

1. **Browser lab, direct key** (`aiui-live/lab`, WebRTC, client delegation, paste/dev key,
   a fake backend with an adjustable delay, two-row captions, a seconds meter, an audio
   level gate for "speaking"). Measures: WebRTC session-creation time and the 15 s charge,
   **echo behaviour with a laptop mic**, interruption feel, transcript grouping, what the
   data channel is permitted to send, the sideband attach on a real WebRTC session.
2. **Channel backend spike** (node, in `exploration/live-probe/` first): the channel
   answers delegations — fast path over page tools with a small Responses call; deep path
   as a prompt push into Claude Code with `oracle_say` / `oracle_note` MCP tools. Measures:
   the fast path's total latency against the 2.9 s hosted baseline, how a 3-minute Claude
   task feels with milestone narration, cancel semantics.
3. **Responses-mode variant** of the lab with the app's tools registered on the backend —
   the zero-infrastructure story for a static-deployed app with a pasted key. Measures:
   `session.update` of `delegation.responses.tools` mid-session (the `setTools` analog,
   unverified), and whether a pending function call blocks new delegations.
4. **Idle economics**: close-and-reseed versus mute, with the reseed built from our own
   transcript; time-to-first-word after resume.

The probe already in `exploration/live-probe/` covers the WebSocket side of 2 and 3 and is
the place to add scenarios before anything touches a package.

## 9. Open questions and risks

- **Sideband on WebRTC sessions** — documented, unverified here (WS-primary attach → 404).
  If it works, the channel needs no tab in the loop; if not, the browser relays.
- **Echo in full duplex** — no VAD to fool, but the model hears whatever the mic hears.
- **Mid-session tool updates in Responses mode** and **pending function calls vs new
  delegations** — both unverified.
- **Cancel reaching Claude Code mid-turn** — the channel can only queue a user turn.
- **The 500-token ceiling** shapes how Claude reports: milestone notes, not transcripts.
- **Cost posture** — $3/h while open is fine for a dev tool with an idle close; it is not
  fine for a forgotten tab. The idle close is load-bearing, exactly like the oracle's park.
- **SDK** — the workspace's `openai` package (7.4, only in `aiui-cf-creds`) predates Live;
  the probe uses raw `ws`, which is enough.

## 10. What was built

Same day, from this document: [`packages/aiui-live`](../../packages/aiui-live/) and
[`demos/live`](../../demos/live/). The decisions above held; the shape that emerged:

- **`LiveSession`** owns the task table, the append/ack ledger (chunked under the 500-token
  cap), the two transcript tracks regrouped by silence, a progress line for quiet tasks
  (measured: the voice model stays silent otherwise, then says "Okay. Checking." on its own),
  and the idle close + re-seed. Transports: WebRTC in the browser, WebSocket in node. Brokers:
  paste-key, dev-key, and a server route that does the SDP exchange (201 in 275 ms, measured).
- **Delegators** are one interface (`handle(req)` with `say`/`note`/`steer`/`log`, tools, an
  abort signal): a scripted stand-in, a Responses loop run by us, a relay to a server, and
  **Claude Code** through the Agent SDK. The relay round-trips page-owned tools, so a server
  backend can move a slider that only exists in the browser.
- **Claude Code as the backend, measured**: one long-lived `query()` per delegator in
  streaming-input mode. A message pushed while a turn runs is *not* interleaved (it was never
  answered), so delegations are serialized on `result`; `interrupt()` aborts the turn and keeps
  the query, which is the cancel path; the CLI's own login authenticates (no API key); MCP tools
  need `alwaysLoad` or the first `say` pays a ~4 s ToolSearch detour. Asked "why does the trace
  look jagged when the samples are low?" with the demo as its working directory, it read
  `graph.ts` and answered in 17.7 s; the voice model relayed the numbers faithfully. The
  Responses fast path (`gpt-5.4-mini`, low effort) did three tool rounds in 4.1 s.
- **Two traps found on the way**: installing the SDK's 210 MB per-platform binary package
  crashes pnpm under Node 24.4.0 exactly (a Node regression, nodejs/node#59057, fixed in 24.5 —
  the repo now requires Node ≥ 24.5 and the SDK's bundled CLI installs normally), and in Solid
  2's beta an effect's cleanup must be its return value, not an `onCleanup` inside the body —
  the oracle's level meter was leaking that way.

Still open from §9: the sideband on a real WebRTC session, echo with a laptop mic (needs a
person), and mid-session `delegation.responses.tools` updates.

## Pointers

- OpenAI docs (append `.md` to any page for the source): `guides/live`, `live-prompting`,
  `live-conversations`, `live-delegation`, `live-migration`, `voice-webrtc?api=live`,
  `voice-websockets?api=live`, `voice-server-controls?api=live`,
  `voice-latency-cost?api=live`, `models/gpt-live-1`.
- [`exploration/live-probe/`](../../exploration/live-probe/) — the scenarios behind §4.
- [`packages/aiui-oracle/docs/oracle.md`](../../packages/aiui-oracle/docs/oracle.md) — the
  oracle as it stands; `packages/aiui-intent-client/src/lanes/oracle.ts` — the panel
  embedding whose tool-source rule carries over.
- [channel-wakeups](./channel-wakeups.md) — the rule a delegation push into Claude Code
  satisfies (actionable by the model alone).
- [live-delegation](./live-delegation.md) — the next design: delegation trees (a
  server-side router, race/classify/fallback), Claude Code over the SDK or over the channel,
  preemption layers, and the four visibility levels.
