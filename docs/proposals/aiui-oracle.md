# The oracle — a realtime voice control surface for aiui apps

Status: ACCEPTED — owner review 2026-07-26 (decisions recorded below). Vendor facts
were researched against the official OpenAI docs on 2026-07-26 (three parallel
research passes; every claim traced to a source, live probes where docs were ambiguous)
plus this repo's own live-verified spike (`exploration/ephemeral-keys/`, 2026-07-20).

## What this is

A new package, `packages/aiui-oracle`: a **pencil-shaped component** — built for the
aiui-viz framework, initially independent of the intent client, designed so it can later be
embedded there without chaos. The oracle is **another control surface**: a deliberately
simple, precise application of the vendors' realtime voice models (OpenAI first, Gemini
later). Unlike the pencil, there is no hard modeling here; the value is the right hooks,
the right visibility, and the right UX around a realtime session.

The retired in-channel oracle (deleted end to end, 2026-07-25/26 — git history keeps it;
`docs/guide/oracle.md` holds the persona of record) rode the intent event stream and the
prompt-lowering pipeline. The new oracle deliberately does **neither**: it contributes
nothing to turns, chips, or prompt lowering. Its whole world is: a realtime session, a tool
surface derived from the page's cells, and widgets that make the session visible.

## The two oracles

One component, two instantiations — the difference is configuration, never a fork:

**The app oracle** — embedded in an aiui app as an app feature. The app's cells are its
tools; the user asks high-level questions ("make the diffusion coefficient interesting")
and the oracle both *sets widgets* and *talks back*. It ships with the app, including to
serverless/static deployments — which is what makes the ephemeral-key story part of the
design, not an afterthought. During development it doubles as a feedback instrument: the
owner talks to the app-under-construction to judge whether it is the right app.

**The intent oracle** — embedded in the intent panel, audio from the panel's own document
(the panel already owns mic capture). Same core, superset tool surface with a different
focus: the tools of the *associated app under development*, reached through the existing
global hook + content-script machinery, so it can move cell values in the driven tab —
plus, potentially, coding/file-reading tools (answer questions about the code) and
knowledge of the intent panel itself ("what button do I press to get into video mode?").
An oracle-as-development-companion. This is O3; nothing in O2 may preclude it.

## What the oracle is NOT

- It does not track navigation or page content. No ambient context capture.
- It does not contribute to intent turns or prompt lowering — no `oracle-*` events, ever.
- It is not an MCP server; the tool schema rides the realtime session config directly.
  (Realtime *does* support remote MCP servers, but those execute on OpenAI's servers —
  "your client doesn't run the remote tool" — so they cannot reach browser-local cells.
  Plain function tools are the correct and only path for our tool surface.)
- It is not the intent client: no modes, no grammar, no capture bus. One session, one
  tool surface, one conversation.

---

## Research findings

### The transport question, settled

**The two transports share one event vocabulary.** The GA reference annotates exactly four
events as WebRTC/SIP-only (`output_audio_buffer.clear` + its three server events) and
**zero as WebSocket-only**. Text injection, image injection, tool calls, out-of-band
responses, session updates — identical on both. The real divergence is **three seams**:

| Seam | WebRTC | WebSocket |
|---|---|---|
| Input audio | mic `MediaStreamTrack` (`input_audio_buffer.append` over the data channel *works* via the official SDK's shared path but is **undocumented**; mixed track+append untested) | `input_audio_buffer.append` (base64 PCM24k) — documented, the primary path |
| Output audio | remote track only — `response.output_audio.delta` is **not delivered** (community-found, SDK-corroborated, not in docs; the sideband-WS workaround reportedly does NOT recover it) | `response.output_audio.delta` PCM events — client owns playback |
| Interrupt / barge-in | **server-managed**: the server knows what played and auto-truncates; manual = `response.cancel` + `output_audio_buffer.clear` | **client-managed**: stop playback, account played-ms yourself, send `conversation.item.truncate` (assistant items only, `content_index: 0`, clamp `audio_end_ms`) |

Everything else that matters is common: transcript deltas both ways, function-call
argument streaming, `session.updated` acks, `error` events. One WebRTC-only caveat: audio
and control ride **separate channels with no mutual ordering** (documented) — any logic
assuming a control event is ordered against an audio position is WebSocket-only reasoning.
The data channel itself is ordered+reliable (SCTP defaults — spec-derived, not
OpenAI-stated). Connection flow: browser POSTs SDP to `POST /v1/realtime/calls`
(`Authorization: Bearer ek_…`, `Content-Type: application/sdp`); data channel
`oai-events`; the response's `Location` header carries a `call_id` (CORS-exposed).

**What you give up with WebRTC, exactly:** (1) reply PCM as data — recoverable only by
tapping the track via WebAudio; (2) cross-channel ordering; (3) the documented input path
if the audio source is PCM rather than a live mic (must reconstitute a track via
`MediaStreamAudioDestinationNode`, or lean on the undocumented `append`). **What you gain:**
browser-grade echo cancellation/jitter handling, and barge-in bookkeeping for free.

**The sideband control channel (new capability, big for O3):** a server holding a standard
API key can join the browser's live WebRTC call at `wss://…/v1/realtime?call_id=rtc_…` —
observing events, sending `session.update`, handling tool calls — while the browser holds
only media + an ephemeral key. `POST /v1/realtime/calls/{id}/hangup` is a server-side kill
switch. This is the documented shape for "the channel participates without the browser
holding credentials," exactly the intent-oracle/channel-minter direction.

### Auth, settled — the user's recollection resolved

**Ephemeral keys work on BOTH transports.** Browser WebSocket auth is officially
documented via subprotocols: `"realtime"`, `"openai-insecure-api-key." + ek`, and
optionally `"openai-organization." + orgId` / `"openai-project." + projectId` — the GA
form drops the old `openai-beta.realtime-v1` entry (carrying it over is a migration bug).
No query-param auth exists. So ephemeral does **not** force WebRTC; transport and auth
are independent axes.

| Credential | WebRTC | Browser WS | Server WS |
|---|---|---|---|
| Ephemeral `ek_…` | SDP POST bearer header (documented, recommended) | subprotocol (documented) | header (spike-verified) |
| Standard `sk-…` | via your server (multipart `sdp`+`session` to `/calls`) | anti-pattern (exposed) | header |

The mint (`POST /v1/realtime/client_secrets`, the ONLY mint — the beta
`/v1/realtime/sessions` is dead, 404-verified live): TTL 10 s–7200 s, default 600. Two
properties that matter:

- **An `ek_` mints MULTIPLE sessions until it expires** — recovery from a drop or the
  60-minute cap needs no server round-trip within the TTL.
- **The baked-in session config is a default, NOT a sandbox** — the client can
  `session.update` over it after connecting. Scope enforcement is the TTL and the
  realtime-only surface, not the config. Minters must not pretend otherwise.

**CORS does not block browser minting** (measured: `access-control-allow-origin: *` on
real responses). Minting stays server-side purely for **key custody** — the parent key
must never reach the client. Worth stating precisely: "CORS blocks it" is a wrong reason
that produces wrong designs.

### Park/resume and cost, settled

- **No server-side pause/resume primitive exists.** But **idle is free**: cost accrues
  only when a Response is created, connections/bandwidth are free, and VAD filters silence
  out of input tokens (documented, three separate statements). **The five-minute park is:
  keep the connection open, gate the mic** (`track.enabled = false` / stop appending).
  Leave `idle_timeout_ms` unset (it deliberately generates responses on silence = a
  metered timer); for a real break, gate audio rather than trusting the VAD threshold.
- **Session ceiling: 60 minutes** (blog-documented). No documented idle disconnect — one
  stale community claim of a 15-minute inactivity cut needs an empirical check (lab spike).
- **Resume after a drop / the cap:** new session + replay via `conversation.item.create`
  — with the documented limitation that **assistant audio cannot be replayed**; assistant
  turns re-enter as text. `previous_item_id: "root"` is the natural slot for a rolling
  summary. Replayed history re-enters as fresh (uncached) input — teardown is what costs,
  parking is free.
- **Pricing** (`gpt-realtime-2.1`, per 1M tokens): audio in $32 / cached $0.40 / out $64;
  text in $4 / out $24; image in $5; mini ≈ ⅓. User audio = 1 tok/100 ms, assistant = 1
  tok/50 ms. The whole conversation re-enters as input per Response (quadratic growth);
  **caching is the lever** (98.75% discount) — and mutating instructions/tools busts it,
  a real cost against a live-updating tool surface. Ballpark: ~$0.50/hr of casual talk
  with cache hits, ~$3/hr without, $0 idle.

### Tool semantics that shape the design

- **The tool surface CAN change mid-session.** `session.update` may change any field
  except `voice` and `model`, any time; `tools` replaces wholesale (`[]` clears); every
  update is acked by `session.updated` with the full effective config — the
  reconciliation signal. This overturns the "tools fixed at start" assumption. (Timing
  against an in-flight response is undocumented; `response.tools` on `response.create`
  turn-scopes exactly when needed.)
- **Keep prompt and tools synchronized** (documented failure mode): a prompt naming an
  absent tool makes the model invent or pretend. The `tools` array is the single source
  of truth; instructions stay generic about which tools exist.
- **No strict schema for realtime tools** (`strict` does not exist here): tool arguments
  are untrusted JSON — the bridge validates defensively before touching a cell.
- **Execution gating rule:** `response.function_call_arguments.done` fires **even for
  interrupted/cancelled responses**. A state-mutating cell write executes only on
  `response.done` with `status: "completed"`; read-only tools may run eagerly.
- Results return via `conversation.item.create` (`function_call_output`, free-text
  output) + an **explicit `response.create`** — still required in GA. Tool failures are
  encoded in the output text (no error channel).
- **`parallel_tool_calls` requires a reasoning realtime model** ("such as
  `gpt-realtime-2`") — "make it wider and blue" as two calls in one turn constrains model
  choice.
- **Turn control:** `server_vad` (threshold/padding/silence; `create_response` +
  `interrupt_response` both default true) is the auto default; `semantic_vad` (eagerness
  low/med/high ≈ 8/4/2 s max) is the better thinking-out-loud mode; `null` = push-to-talk.
  The middle mode — VAD events with `create_response: false` — is the documented hook for
  "enrich before dispatch" patterns; noted for later, not v1.
- **Context injection:** `conversation.item.create` supports system/user/assistant items
  (system is schema-documented, never demonstrated — verify live before load-bearing use)
  and `previous_item_id` placement; out-of-band responses (`conversation: "none"` +
  `metadata`, or `input` item-reference subsets) enable side-channel queries that don't
  pollute the conversation.
- **Hygiene from day one:** set a client `event_id` on every sent event (the only way to
  attribute `error` events); `response.cancelled` does NOT exist (doc bug — listen for
  `response.done` `status: "cancelled"`); `response.cancel` is safe to fire
  speculatively; voice is immutable after first audio (pick `marin`/`cedar` up front);
  PCM is 24 kHz only; `output_modalities` is audio (with transcript) XOR text;
  `noise_reduction` near/far field is a config knob worth surfacing.
- **Tool definitions count against the context/truncation budget** (instructions include
  tools) — another cost of a very large surface.

---

## Architecture

### The chromeless core

A headless session engine (`src/` — DOM-free where possible, browser edges injected, the
runtime's discipline) with two pluggable seams fixed on day one:

- **Transport** — `WebRtcTransport | WebSocketTransport` behind one interface. The
  interface isolates exactly the three divergent seams (input audio, output audio,
  interrupt); everything else — session config, items, tools, responses, transcripts —
  is one shared event path. Transports advertise **capability flags** (`replyAudioData`:
  WS only; `serverBargeIn`: WebRTC; `injectAudio`: WS documented / WebRTC undocumented),
  and widgets read the flags — a feature missing on one transport is *visibly absent*,
  never silently broken. The parity research says this abstraction is well-supported;
  if reality diverges further, the flags are the managed-complexity seam.
- **KeySource** — `paste-key` (localStorage; standalone/static default), `dev-env` (a
  dev-server seam to the OS vault / env — dev mode in the lab and the extension; the key
  never enters the client bundle), `ephemeral-mint` (a URL exchanging identity for an
  `ek_`; the cloud function for static sites, the channel later). The core sees only
  "credential for session config X". Handles both expiry manifestations (401 at upgrade
  AND post-open error frame — both observed live in our spike), and reuses a live `ek_`
  for reconnects within its TTL.

Between them sits the **session engine**: config (model, voice, instructions, tools, turn
control — `server_vad` auto default), the conversation state machine (including **park**
as a first-class state: connection open, mic gated, $0), and one **normalized session
ledger** — an append-only, typed stream of everything (session lifecycle, turns, tool
calls + results with their gating status, injected text/images, errors, usage/cost from
`response.done`). The ledger is what widgets render and what the raw-JSON view indexes;
vendor events map into it and unrecognized ones are retained raw, never dropped (the
trace-stages total-parse lesson).

**Sideband-ready** (owner decision, 2026-07-26): the WebRTC transport surfaces the
`call_id` from the SDP response's `Location` header as first-class session state (ledger +
a core accessor), so a server-side participant — the channel, a dev harness — can attach
to the live call over `wss://…?call_id=…` with its own key. The core treats a sideband
participant as a peer that may also send `session.update` / handle tools; the
`session.updated` reconciliation path (below) is what keeps the two participants honest
with each other. Supported by design now, exercised fully in O3.

### The tool bridge

Tools merge from: (1) **the aiui surface** — the page's agent toolkit, the same cells and
actions the coding agent sees; (2) **custom tools** from the integrator; (3) *(O3)* the
driven tab's toolkit over the global hook. The bridge owns schema derivation, defensive
argument validation, execution, and ledger reporting. Executing a cell write is
Solid-correct — through the cell's own `set` under the proper owner, so the UI updates
exactly as if the user moved the widget. The gating rule above (mutations only on
completed responses) is the bridge's, not each tool's.

**The tool surface is live from day one** (owner decision, 2026-07-26): the bridge
supports mid-session — and mid-turn, via `response.tools` — tool changes, reconciled
against `session.updated` (the server's ack carries the full effective config; the bridge
compares intended vs. effective and reports drift into the ledger). The cache-busting cost
of mutating the surface is *documented and surfaced* (the ledger's usage entries make it
visible), never a reason to preclude the capability — flexibility is the API's default
posture.

### The prompt

Standard pieces woven with an application-specific portion: a base persona (seeded from
the persona of record in `docs/guide/oracle.md`), a generated *generic* description of how
to use the surface (never naming individual tools — the sync rule), and the integrator's
app-specific text. Every piece inspectable in the session viewer — "every prompt is
documented."

### The widgets

All optional, all reading the core's ledger + state cells; the integrator composes:

- **The control** — start / park / resume / stop, mute (track.enabled, never teardown),
  level meter, connection + cost status (usage totals from the ledger).
- **The session viewer** — the detailed full-session view: chips/cards per ledger entry
  (turns, tool calls with args/result/gating, injected items, errors, usage), raw vendor
  JSON where it makes sense. The trace-debugger sensibility applied to a live session.
- (Later: transcript pane, tools inspector.)

### The lab

The pencil playbook: `lab/` inside the package — a real aiui app (cells + widgets + the
oracle wired in), `vite --config lab/vite.config.ts`, `host: true`, dev-key seam active.
First light doubles as the empirical spike run (below).

## Key flows (the auth matrix, resolved)

| Context | Key source | Transport | Notes |
|---|---|---|---|
| Lab / dev app | dev-env (vault via `aiui keys` / `.env`) | either | dev-server-only seam; key stays out of the bundle |
| Standalone page, personal | paste-key → localStorage | WebRTC default | the v1 accepted mode |
| Static site, owner-only | ephemeral-mint (JWT→`ek_`) function | WebRTC | proxy-jwt exploration made this concrete; browser-WS also viable |
| Channel present (O3) | channel as minter — or the **sideband**: browser holds `ek_`+media, channel joins by `call_id` with the vault key | WebRTC + sideband WS | the documented server-participation shape |

## Decisions (owner-approved 2026-07-26)

1. **WebRTC first** (O2a): best pure-voice UX (echo cancellation, free barge-in), the
   documented browser path. The reply-PCM loss and the cross-channel ordering caveat are
   **accepted** — neither matters here. **The live mic is THE input**: v1 assumes it, so
   no PCM-injection path is needed on the WebRTC side. **WebSocket second** (O2b), same
   interface — motivated by the intent oracle (the panel's PCM capture feeds `append`
   naturally) and by reply-audio-as-data if ever needed.
2. **The sideband control channel is supported by design** — `call_id` surfaced
   first-class, sideband participants treated as peers (see Sideband-ready above).
3. **Mid-session AND mid-turn tool changes are supported day one.** The general posture:
   nothing is precluded because of cache or validation cost — the API stays maximally
   flexible, and costs are surfaced (in the ledger) rather than gating.
4. **Model `gpt-realtime-2.1`** (the pricing page's name — pin from a live session echo
   per the house verify-vendor-params rule); parallel tool calls need the reasoning tier.
5. **Voice `marin`** (recommended pair; immutable after first audio). `server_vad` auto
   as default turn mode; `semantic_vad` exposed as config.
6. **Park = first-class state** (mic-gate, connection open); resume-by-replay only as
   the recovery path (drop / 60-min cap), assistant turns replayed as text.

## Lab spikes (first-light verification list)

1. `session.update` tools mid-session + `session.updated` reconciliation; behavior when a
   response is in flight; `response.tools` turn-scoping. (Promoted to #1 — the live tool
   surface is now a day-one capability.)
2. Park 20+ min with mic gated → does the connection survive (the 15-min community claim)
   and does `response.done` usage confirm $0 idle + real cache hit rates?
3. System-role `conversation.item.create` (schema-only today).
4. `response.output_audio.delta` suppression on WebRTC (the one load-bearing
   community-only fact) — confirm before the ledger assumes track-only audio.
5. Sideband attach: a Node script joins the lab's call by `call_id` and observes events.
6. (Deferred with the live-mic decision:) `input_audio_buffer.append` over the WebRTC
   data channel — only before the intent oracle depends on it.

## Phasing

- **O2a** — scaffold (`pnpm new-package aiui-oracle --public --no-reserve`; npm reserve
  waits for owner 2FA), lab skeleton, core engine on WebRTC + paste-key, tool bridge over
  the lab app's cells (live-update API shape from the start), control widget. ⭐ first
  light: owner talks to the lab app, the oracle sets a cell; spike list runs.
- **O2b** — session viewer; WebSocket transport behind the same interface; capability
  flags honest; park/resume polished; sideband attach exercised.
- **O2c** — dev-env key seam; ephemeral-mint source (cloud function); reconnect-by-replay.
- **O3** — the intent oracle: embed in the panel, superset tools over the global hook,
  sideband/channel-minter exploration. Separate proposal when we get there.

## Sources

Official: developers.openai.com guides (realtime, -webrtc, -websocket, -conversations,
-server-controls, -vad, -mcp, -costs, -models-prompting, -transcription), API reference
(realtime client/server events), the realtime developer blog, the gpt-realtime-2.1 model
page, pricing. (Tip that made this cheap: every `developers.openai.com` page has a `.md`
twin returning raw markdown; `platform.openai.com/docs/*` 301s there; `/llms.txt` indexes
the set.) Community findings are labeled as such above — the load-bearing one (WebRTC
audio-delta suppression) is corroborated by the official Agents SDK's transport sources.
Repo ground truth: `exploration/ephemeral-keys/RESEARCH.md` (live-verified 2026-07-20).
