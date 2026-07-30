# The intent oracle — the oracle inside the intent panel (O3)

Status: ACCEPTED — owner review 2026-07-30 (decisions recorded below). This is the
separate proposal `aiui-oracle.md` promised for O3 ("the intent oracle: embed in the
panel, superset tools over the global hook, sideband/channel-minter exploration").
It builds on two things already landed: the oracle package through O2c
(`packages/aiui-oracle`), and the intent client's **sink** — the pause slice of
2026-07-30 (`packages/aiui-intent-client/BEHAVIOR.md`, "The sink, and pausing a turn"),
which was designed around this proposal's arrival.

## What this is

The panel oracle is the same `OracleSession` the lab drives, mounted as a **second sink**
for the intent client's contributions. Turning it on pauses the open turn; turning it off
restores whatever that turn was. Its tool surface is a superset of the app oracle's: the
driven page's tools, the panel's own command bar, and local file tools reached through the
channel.

It remains what the founding proposal said it was NOT: no ambient context capture, no
`oracle-*` events, no contribution to prompt lowering. The pause bracket in the intent
stream is deliberately reason-free — a manual pause and an oracle detour read identically
there, and the panel's banner is the only place the reason lives.

## What is already built (why this is mostly wiring)

- **`OracleSession`** — lifecycle (`start`/`park`/`resume`/`close`/`stopSpeaking`), the
  completed-response tool gate, live `setTools`/`setInstructions`, `sendText(text, {respond,
  role})`, `sendImage(dataUrl, caption)`, the normalized ledger, usage tallies,
  `playbackBlocked`.
- **Widgets** — `OracleControl`, `OracleMind` (the ambient "what is it doing" line),
  `OracleViewer` (turn-grouped ledger, category chips, progressive detail).
- **`mint-backend.ts`** — written as a host-neutral `handleHttp(req, res): boolean` seam
  whose own doc anticipates "later, the channel sidecar."
- **The page-tools bridge** — `tools-link.ts` already receives `pageTools` descriptor
  events per tab and invokes `toolsCall`, with `toolsResult` correlated by `callId`. The
  oracle is a second consumer of that existing feed; no new page capability is needed.
- **The selection renderers** — `renderAppSelection` / `renderCodeSelection` are already
  exported from the lowering pipeline precisely "so any re-attacher shares THIS exact
  rendering — one implementation, per the defer-rendering rule."
- **The read-file policy** — `executeReadFile` plus its documented policy (32 KB cap with a
  truncation marker, NUL-byte binary sniff, errors returned to the model as readable
  strings, relative paths against the project root, every call recorded).

## The machine

### The oracle is a region AND a claim

Two layers that must not be conflated: the **region** is the user's desire, the **claim**
is the reconciled reality.

- `oracle: toggle({ durable: true })` — armed-scope, cleared by `disarmed-is-hard` (a live
  WebRTC session must never outlive disarm). Deliberately NOT in `escOrder`, like
  pencil and jump; the hard exit is `d` / the arm cap.
- `available.oracle` gates on `ctx.connected` (the mint lives on the channel) and
  `ctx.micGranted !== false` (a definitively refused mic means the oracle cannot work;
  `undefined` — never asked — must not dead-end the cap).
- An `oracleSession` **claim** derives on `s.oracle === true`: `acquire` mints a
  credential and starts the session; `release` closes it. The claim reconciler then
  supplies the async story — idle → pending → active → **error** — which the pill strip
  already renders, exactly like the video pump. A mint 503, a denied mic, or an ICE failure
  surfaces through the machinery that already exists instead of a hand-rolled connect state
  sitting next to a mode flag.

  Two things the build taught, both corrections to the paragraph above as first written:
  `OracleSession.start()` is chromeless and **resolves either way**, recording the cause in
  its own ledger — so the lane must translate a failed start into a rejection, or the claim
  reports `active` over a session that never connected. And the reconciler never calls
  `release` for an acquire that threw (nothing was held), which leaves the session at
  `error` where its own `start` guard refuses to run again — so the lane closes it first,
  or the retry is a silent no-op. Both were found by tests, not in the wild.

### The sink's second arm

`sink(state)` (spec.ts) grows the arm it was written for:

```
sink = oracle ? "oracle"
     : (phase === "turn" && !paused) ? "turn"
     : undefined
```

Consequences, all of them already designed:

- **Entering the oracle pauses the turn by construction** — the sink is elsewhere. The
  oracle never writes the manual `paused` region, so leaving restores whatever the turn's
  own state was. No memory, no restore logic, anywhere.
- **The contribution caps and keys are already hoisted** to the armed tier and gated on
  the sink (shot · area · selection · push-to-talk, `s`/`a`/`p`/Space). They light with no
  turn open the moment an armed-scope sink exists. The armed key layer's sink-gated rows
  were landed unreachable for exactly this day.
- **Opening a turn while the oracle is live is allowed**, and it opens already-paused (the
  banner explains it). That is what makes "start a turn, dip into the oracle, come back"
  work.

### The mic: the oracle's alone, and park is its only control

**Superseded, and worth recording as a wrong turn** (owner, 2026-07-30, after living with
O3a). This section first said the oracle *inherits the talk region* — `off` hears nothing,
hands-free hears continuously, a hold hears while Space is down — and that the mic gate was
a conjunction of the grip, park, and mute. That is retired.

Why it was wrong: the oracle holds its own WebRTC track and the package already gives it a
`park`. Borrowing the turn's grips made **two independent mechanisms answer one question**,
and it coupled the oracle to a region that has nothing to do with it. It also made the
promise "leaving the oracle restores the turn exactly" a *rule* to maintain rather than a
consequence.

The rule now:

```
micEnabled = sink === "oracle" && !oracleParked
```

- **Turning the oracle on means listening.** That is what turning it on is for.
- **Park (`⏯`) is the whole mic control** — a child of the lit oracle cap, the package's own
  vocabulary for "hold my place": track gated, session open, $0.
- **Talk is the turn's alone.** A hold ends when the turn stops collecting
  (`hold-needs-the-turn`); a standing hands-free MODE survives an oracle detour with its
  window closing on the way in and reopening on the way out. Nothing about the turn's talk
  state is touched, so restoring it is not a feature — it is the absence of one.
- **Mute stays the turn's**, for the same reason.

**Still applied at two moments** (`oracleMic`, spec.ts): the client relays every edge, and
the lane applies the same predicate once more the instant a session finishes connecting,
because a connect is not an edge and the vendor's track comes up enabled.

**Each sink owns its own capture path — corrected against the build (O3a).** This proposal
originally said a `turn → oracle` handover would keep one mic source live and re-route its
PCM. The implementation refutes it: the WebRTC transport opens its **own** track inside
`connect()`, while the turn's talk lane has its own `PcmSource`. There is no shared source
to hand over.

The outcome is better than the design it replaces. The oracle's track is opened once at
connect and only enabled/disabled after, so a handover **stops the turn's lane and flips a
boolean** — no device re-open on either side, no gap to flicker through, and never two
captures at once. (The speculative swap arm left in the pause slice would have started the
turn's capture while the oracle held the sink; a handover test caught it.) What survives
intact is the rule that motivated the original claim: mute is a property of the source, so
every way of saying "don't listen" gates the source rather than detaching a route.

## The lifecycle, as the user experiences it

1. **Press 🔮 oracle** (armed tier, `remote: true` — asking from the couch is the case).
   An open turn pauses itself; the banner reads "oracle live — the turn is paused."
2. **The claim connects** — pill pending, then active. The `OracleMind` strip under the bar
   carries the ambient line ("connecting… / ready — talk to it / listening… / doing:
   set_freq / parked").
3. **Talk — it is already listening.** Park (`⏯`) when you want it to stop; the session
   stays open and free. Your turn-side grip is untouched throughout.
4. **Contribute** with the same caps and keys as a turn: 🖼 shot, ⛶ area, 📋 selection.
5. **Park** to hold your place; **shush** to cut a reply short (the session's manual
   barge-in, safe with nothing in flight).
6. **Press 🔮 again** to close. The turn un-pauses to exactly what it was. `d` / the arm cap
   is the hard exit, and disarm always closes the session.

Panel surfaces: `OracleMind` under the bar; `OracleViewer` behind a fold beside the trace
pane (the oracle's ledger IS its trace — the intent trace stays neutral); an `oracle` pill
for the claim status. `playbackBlocked` routes to the existing toast — and note the measured
asymmetry it exists for: an extension document is exempt from the autoplay gate, a plain
page is not.

## The tool surface

Three groups, each a standing config toggle in the panel's config strip (durable and
agent-visible, exactly like `stt` / `linter`). Assembled at session start and kept live
through `setTools`, which the package supports mid-session by design.

### 1. The driven page's tools — LANDED (O3b)

From the existing `pageTools` feed, re-projected into `session.setTools(...)` on tab switch
and on every registry change — so a navigation swaps the surface live. **The tools follow
the tab in view** (owner, 2026-07-30), consistent with every other page act; the surface
can therefore change mid-sentence, which is the honest behavior rather than a pinned lie.

Three things the build settled:

- **A second, independent consumer of the page-event stream** (`page-tools.ts`) rather than
  a layer over `tools-link.ts`. That module owns a socket lifecycle — dial, re-dial,
  register, close-means-forget — which has nothing to do with a local reader, and
  entangling them would tie the oracle's tool surface to the health of a channel socket it
  never uses. The one thing the two consumers must agree on is the `callId` space: both
  issue `toolsCall` on the same page and both hear every `toolsResult`, so ours are
  prefixed and each side ignores what it did not issue.
- **A projected tool is bound to the tab it was built for**, not to whatever tab is in view
  when the model finally calls. A switch re-projects, and the stale tool goes away with the
  projection that made it.
- **Applied at two moments**, the same rule the mic gate needed and for the same reason: a
  connect is not a change, so an edge-driven projection alone hands a freshly-opened
  session nothing.

### 2. The panel's own bar — writeable. LANDED (O3c)

`panel_bar_list` returns the projected caps with their enabled state and hints, so the
oracle can answer "what button do I press to get into video mode?". `panel_bar_dispatch`
then presses it (owner, 2026-07-30: writeable, not read-only).

**Which caps it may press is DECLARED, not deny-listed.** A deny-list is safe only until
someone adds a command; `CapSpec` already carries `remote?: boolean` for the caps the iPad
may tap, so the oracle gets the identical mechanism: `oracle?: boolean`, declared beside
the cap in `caps.ts`, absent by default. Two gates then apply — the flag (never allowed)
and the machine's own `canDispatch` (not allowed right now) — and a new cap is excluded
until someone deliberately opts it in.

Three families deliberately carry no flag:

- **Turn lifecycle** — `send`, `turn`, `cancelTurn`, `pause`. Sending is irreversible and
  outward-facing; the other three discard or duplicate what the oracle already did by
  taking the sink.
- **The ladder** — `arm`, `disarm`, `escape`, `oracle`. Each would end the session that is
  asking.
- **Its own hearing** — `handsFree`, `mute`, `talkPress`, `talkRelease`, and park. The mic
  is the user's, and a model that can gate its own input can lock itself out of the
  instruction that would restore it.

What that leaves, and it is the interesting part: `pencil`, `pencilClear`, `jump`,
`region`, `shot`, `selection`, `video`, `fpsMode`, `help`.

### 3. Local file tools, through the channel — LANDED (O3c)

The oracle runs in the browser and speaks WebRTC straight to the vendor, so a file read has
to cross into node. The channel already holds the policy; the panel reaches it over one
route.

- **Route**: `POST /intent/oracle/tool` with `{ tool, args }` answering
  `{ ok, content, summary }` — mounted on the **intent sidecar**, beside `/intent/cdp/info`.
  No new sidecar, no new listener, no new posture, and the sidecar already knows `root` for
  the cwd. One route for all three tools, mirroring `runConsumerToolCall`'s shape.
- **`read_file`** — `executeReadFile`, unchanged.
- **`list_files`** — a bounded directory listing (owner, 2026-07-30). Entry cap with an
  explicit truncation marker; `.git` and `node_modules` skipped by default — signal, not
  security.
- **`grep`** — a bounded regex search. Caps on matches, on files scanned, and on per-line
  length, each surfaced in the result rather than silently applied. A plain node walk: the
  cap is the point, so an external ripgrep dependency buys nothing a voice conversation
  can use.

The three share ONE policy module (the channel's `linter-tools.ts` grows the two new
executors) and one observer shape, so the recording property holds uniformly. The
**advertised** surfaces stay different: the linter keeps advertising `read_file` alone — its
policy is deliberately "verify suspicions, don't browse" — while the oracle route advertises
all three.

**Recording.** Every call and result lands in the oracle's ledger as `tool-call` /
`tool-result` (the viewer renders both halves), plus a channel log line. So the linter's
honesty property — nothing the model read is invisible — holds without putting anything in
the intent trace. This does not widen the security posture: the same port already grants the
linter identical read capability under the documented trusted-LAN bind. It does mean the
oracle's reads must stay as visible as the linter's, which is why the ledger is not
optional.

### The mint

`POST /intent/oracle/mint` on the same sidecar, mounting `createMintBackend` with
`resolveKey` wired to the channel's already-resolved OpenAI key. This is the honest end of
the installed-keys posture: the parent key stays in the channel process, the panel only ever
sees an `ek_`. Panel side: `cachingKeySource(mintingKeySource(...))` with `pasteKeySource`
ahead of it, so a user's own key still trumps.

## Contributions: shots and selections

Routing is already paid for by the hoist — the same caps and keys contribute to whichever
sink is live. The fork is three lane verbs (`takeShot`, `addSelection`, the region-drag
pump), which is exactly why the pause slice avoided baking `"turn"` into them.

**Both land with `role: "user"` and `respond: false`** (owner, 2026-07-30). The item enters
the conversation and whatever the user says next picks it up; forcing `response.create`
would make the oracle start talking over a user who is mid-sentence. Role `user` rather than
`system` because system-role `conversation.item.create` is schema-only-today on the
founding proposal's spike list — unverified, and the house rule is to never design on an
unverified vendor param.

### Selections — the exported renderer, and nothing else

`requestPage(tab, "selection")` yields an `AppSelection`; `renderAppSelection(item)` renders
it; `sendText` sends it. One pure function call on one item. Contributed code selections use
`renderCodeSelection` identically.

This is the "same format, simplified" the owner asked for, and the simplification is
structural rather than a shortcut: `composeIntent`'s five passes exist to order MANY events
into ONE prompt, and an oracle conversation is already ordered by arrival — so the timestamp
interleave, the retraction fold, and the correction application are unnecessary **by
construction**, not skipped. `cwd` is undefined in the browser, so paths stay absolute:
honest, not a fudge.

### Shots — one small extraction

`grabShot(tab)` gives bytes plus a data URL; `sendImage(dataUrl, caption)` attaches it. The
caption is the one place the two formats must legitimately diverge: the lowering's line is
`[screenshot located at <path>]`, and the oracle has **no path** — the pixels ride inline, so
emitting `MISSING` there would be a lie.

So: factor the element/cell metadata block out of the private `renderShot` in `render.ts`
into an exported helper, and the oracle's caption becomes `[screenshot attached]` plus that
same block. `renderShot` calls the helper too, so the element and cell rendering — including
the `MAX_ELEMENTS_IN_PROMPT` / `MAX_CELLS_IN_PROMPT` collapse rules — stays single-sourced.

### The session prelude

Weave the tab context into the instructions at connect (`renderTabRecord` plus the app
blurb), so the oracle knows what it is looking at without a tab record riding every item.
The CDP-alignment fact is available here too and worth a sentence in the woven prompt for
the same reason the lowered prelude carries one.

## What deliberately does NOT route to the oracle

- **Video sampling stays turn-only.** A frame a second into a realtime session is a token
  firehose. The sink says *whether* collection happens; per-source routing remains a
  per-source decision, so `videoSample` derives on `sink() === "turn"` specifically. Ad-hoc
  shots are the oracle's picture.
- ~~Until O3d, so do shots, area drags, and selections.~~ **Landed**: they follow the sink
  now. What does NOT follow is TALK — the turn's grips are the turn's permanently, since
  the oracle hears through its own track under its own park.
- **Pencil strokes** route nowhere, as today — they are page markup, and a shot taken after
  drawing carries them.
- **Navigation and tab boundaries** are not oracle events. The turn's own
  suppress-and-compare rule already covers the gap an oracle detour leaves behind.

## Decisions (owner-approved 2026-07-30)

0. **The oracle's mic is its own** (2026-07-30, after living with O3a): a session listens
   from the moment it is on, park is its only gate, and the turn's talk grips are never
   consulted. Supersedes the "inherits the grip" decision this proposal shipped with.
1. **Contributions do not solicit a reply** — `respond: false`.
2. **Role `user`**, not `system` — the verified path; the system-role spike stays a spike.
3. **The panel bar is WRITEABLE to the oracle**, gated by a declared `oracle?: boolean` cap
   flag (mirroring `remote`), with turn lifecycle, the ladder, and its own hearing excluded.
4. **Park is exposed** as a child of the oracle cap, its own region, independent of the talk
   grip.
5. **App tools follow the tab in view**, consistent with every other page act.
6. **File tools are read, list, and grep** — one shared policy module, one route, bounded
   and recorded.

Carried from `aiui-oracle.md` and unchanged: WebRTC transport, `gpt-realtime-2.1`, voice
`marin`, `server_vad` default, park as a first-class state, mid-session tool changes.

## Open questions and spikes

- ~~**Session lifetime.**~~ **Settled (owner, 2026-07-30): one fresh credential per
  session, and no session outlives the vendor's cap.** Two independent clocks, and
  conflating them is the trap:
  - the **credential TTL** (10–7200 s; the channel mints at 600) bounds how long a secret
    may *open* a session. It is set server-side because the server holds the parent key;
    the page POSTs a session config and gets a secret, never a duration.
  - the **session lifetime** (~60 minutes, the vendor's) bounds how long an *opened*
    session runs. A session outliving its credential is normal and fine.

  The panel therefore mints per `start()` — plain `mintingKeySource`, deliberately not
  `cachingKeySource`. Caching earns its keep against a mint that costs something (a cloud
  function, a cold start, a metered call); ours is a loopback round trip to our own
  channel, so freshness is worth more than the milliseconds saved, and nothing outlives
  the conversation it opened.

  We do not manage the cap — we **handle** it. A session that ends without being asked to
  drops the desire and says why, so the cap never stays lit over a dead session. Pressing
  🔮 starts a fresh one, with a fresh credential. Auto-reconnect is deliberately absent: a
  new session carries no history, so silently reopening one would fake a continuity that
  does not exist.
- **System-role context items** — spike #3, still open. It is the cleaner home for
  selections and captions if it works.
- **Two panels, one oracle.** Nothing stops two panels each holding a session. Cost is the
  only consequence; naming it here so it is a known, not a surprise.

## Phasing

- **O3a — the session in the panel. DONE.** The `oracle` region, cap, and claim; the sink's
  second arm; the mint route; the mic mapping through talk / park / mute; `OracleMind`, the
  viewer fold, the pill, the banner text. ⭐ first light: press 🔮, talk, hear it answer.
- **O3b — the app surface. DONE.** `pageTools` into `setTools`, live re-projection on tab
  and registry change, the `oracle tools` toggle. Now it drives the app.
- **O3c — files and the panel. DONE.** The `/intent/oracle/tool` route with `read_file`,
  `list_files`, and `grep`; `panel_bar_list` and `panel_bar_dispatch` behind the `oracle`
  cap flag; the three config toggles (file tools off by default — reading source is a
  bigger step than driving a UI). One thing the build added: `panel_bar_list` must
  FLATTEN the bar's depth-first forest, or the oracle is handed three root caps and told
  that is the panel (found by test).
- **O3d — contributions.** Shot and selection routing, the `renderShot` metadata extraction,
  the caption format, the session prelude.
