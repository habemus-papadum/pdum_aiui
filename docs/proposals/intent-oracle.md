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
  credential, constructs the session and starts it; `release` closes it. The claim
  reconciler then supplies the async story for free — idle → pending → active → **error** —
  which the pill strip already renders, exactly like the video pump. A mint 503, a denied
  mic, or an ICE failure surfaces through the machinery that already exists instead of a
  hand-rolled connect state sitting next to a mode flag.

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

### The mic: talk, park, and mute all mean "do not listen"

The oracle does not listen on activation; it inherits the talk region (owner, 2026-07-30 —
this is what removed the hot-mic hazard from the design).

| `talk` | the oracle's mic |
| --- | --- |
| `off` | gated |
| `handsFree` | open; server VAD takes turns |
| `hold` | open while Space is held — release gates it, and the silence ends the VAD turn |

So the window derivation the pause slice already wrote in sink-identity shape gains one
arm: where sink `turn` maps open/close to `startTalk`/`stopTalk`, sink `oracle` maps it to
`resume()`/`park()`. Same block, one more arm, and the mode/window discipline is unchanged.

**Park is exposed as its own affordance** (owner, 2026-07-30): an `oracleParked` toggle
revealed as a child of the lit oracle cap — the package's own vocabulary for "hold my
place," independent of your talk grip, so parking does not destroy hands-free and
un-parking restores it.

The mic gate is therefore the conjunction of three independent ways to say the same thing,
which is monotone and cannot surprise:

```
micEnabled = sink === "oracle" && talk !== "off" && !oracleParked && !micMuted
```

**A consumer swap keeps the source live.** `talk: handsFree` with the sink moving
`turn → oracle` is a re-route, not a stop-and-start: the mic source stays held and only the
PCM's consumer changes. Restarting it would drop a device gap and flicker REC mid-sentence,
and it would contradict the standing rule that mute is a property of the source and never
of a route.

## The lifecycle, as the user experiences it

1. **Press 🔮 oracle** (armed tier, `remote: true` — asking from the couch is the case).
   An open turn pauses itself; the banner reads "oracle live — the turn is paused."
2. **The claim connects** — pill pending, then active. The `OracleMind` strip under the bar
   carries the ambient line ("connecting… / ready — talk to it / listening… / doing:
   set_freq / parked").
3. **Talk with whatever grip you had.** With `talk: off` nothing is heard — press `h` or
   hold Space. With hands-free already on, the mic simply re-routes.
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

### 1. The driven page's tools

From the existing `pageTools` feed, re-projected into `session.setTools(...)` on tab switch
and on every registry change — so a navigation swaps the surface live. **The tools follow
the tab in view** (owner, 2026-07-30), consistent with every other page act; the surface
can therefore change mid-sentence, which is the honest behavior rather than a pinned lie.

### 2. The panel's own bar — writeable

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

### 3. Local file tools, through the channel

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
- **Pencil strokes** route nowhere, as today — they are page markup, and a shot taken after
  drawing carries them.
- **Navigation and tab boundaries** are not oracle events. The turn's own
  suppress-and-compare rule already covers the gap an oracle detour leaves behind.

## Decisions (owner-approved 2026-07-30)

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

- **Session lifetime.** The vendor caps a session around 60 minutes and the founding
  proposal's park spike (20+ minutes with the mic gated) was never run. The panel oracle's
  expected use is a minute or two, so this is not slice-1 blocking — but the claim's
  `acquire` is the natural place for a re-connect, and `resume-by-replay` exists in the
  proposal as the recovery path.
- **System-role context items** — spike #3, still open. It is the cleaner home for
  selections and captions if it works.
- **Two panels, one oracle.** Nothing stops two panels each holding a session. Cost is the
  only consequence; naming it here so it is a known, not a surprise.

## Phasing

- **O3a — the session in the panel.** The `oracle` region, cap, and claim; the sink's second
  arm; the mint route; the mic mapping through talk / park / mute; `OracleMind`, the viewer
  fold, the pill, the banner text. No tools beyond the package's own `report`.
  ⭐ first light: press 🔮, talk, hear it answer.
- **O3b — the app surface.** `pageTools` into `setTools`, live re-projection on tab and
  registry change, the `page` toggle. Now it drives the app.
- **O3c — files and the panel.** The `/intent/oracle/tool` route with `read_file`,
  `list_files`, and `grep`; `panel_bar_list` and `panel_bar_dispatch` behind the `oracle`
  cap flag; the three config toggles.
- **O3d — contributions.** Shot and selection routing, the `renderShot` metadata extraction,
  the caption format, the session prelude.
