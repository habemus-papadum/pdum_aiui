# Delegation trees for aiui-live

A server-side router that delegates to other delegators, Claude Code reached two ways (the
Agent SDK, or the interactive session over the custom channel), preemption from the page,
and visibility that scales from "what is it doing" to "why did it take 40 seconds".

Status: **DESIGN SKETCH, 2026-09-16.** Nothing here is built. Every claim about existing
code cites the file; every claim about the vendor cites the `.md` docs page. Open decisions
are collected in [§9](#9-decisions-to-make); the rough file plan is [§8](#8-rough-code-structure).
Background: [oracle-live.md](./oracle-live.md) (why GPT-Live, what was measured, §5–§6 of
which already sketch the channel as a backend) and the live tour page
(`demos/live/tour.html`, which shows every wire event and SDK option named below).

## 0. In one screen

**What we want.** A delegation today is one ticket handed to one delegator
(`packages/aiui-live/src/types.ts`, `Delegator.handle(req)`). We want a *tree*: a router that
answers quick questions itself and escalates hard ones, a race between a fast model and Claude
Code, a fallback after a timeout, and so on, with the shape chosen by the user from the page,
and with every node visible while it runs and inspectable after it fails.

**The three ideas that carry the design:**

1. **The delegator seam is already the composition unit.** A router is a `Delegator` whose
   `handle` calls other delegators with a derived request. No new protocol is needed for
   the composition itself, only for describing it (a *plan*) and for observing it (*spans*).
2. **Everything observable is a span.** Each delegator invocation on a ticket opens a span
   with a parent; every append and log line carries its span id. One substrate, rendered at
   four levels of detail (§6).
3. **Claude Code is two leaf delegators with one brief.** `claude-sdk` (exists) owns a
   headless `query()`. `claude-channel` (new) pushes the ticket into the interactive session
   through the channel and gets the answer back through sidecar-registered MCP tools. Same
   spoken contract, different process, different interruption story (§4, §5).

**What the vendor fixes for us** (`voice-server-controls.md?api=live`): there is no client event
that stops the voice model's speech. `session.instructions.append` "can interrupt speech in
progress"; `session.input_audio.mute` "does not mute model output or cancel delegated work";
and "interrupting speech does not automatically cancel backend work". So preemption is three
separate layers we own (§5), and the page must be able to fire each one without the model.

## 1. What exists (the parts the design leans on)

| Piece | Where | What it gives the design |
| --- | --- | --- |
| `DelegationRequest` = `{id, text, transcript, tools, signal, say, note, steer, log}`; `Delegator.handle(req) → Promise<string \| void>` | `packages/aiui-live/src/types.ts` | The seam. `say/note/steer/log` are plain functions, so a router can wrap them; `signal` is an `AbortSignal`, so cancel propagates by linking controllers. |
| Task table: `LiveTask {id, status, request, appends, log, backend, firstAppendT, firstSpokenT, doneAt}`; `cancelTask` aborts the controller; a cancelled task refuses late appends (`task cancelled` receipt) and late results (`status !== "open"` guard) | `src/session.ts` | Late results are already dropped. The ticket is the unit of cancellation. |
| Ledger: `LedgerEntry {seq, t, dir, kind, summary, delegationId?, event?}` | `src/types.ts` | The one event stream the widgets render; needs a `spanId`. |
| Relay frames: client `hello \| delegate \| cancel \| tool_result`, server `ready \| say/note/steer \| log \| done \| failed \| tool \| error` | `src/delegators/relay-protocol.ts` | Flat: one delegator per connection, named in `hello`. Needs `plan`, `configure`, `stop`, span frames. |
| Server: `DelegatorFactory(ctx: {sessionId?, log})`, a `delegators` registry by name, `handleHttp/handleUpgrade` that "mount identically into a Vite dev server, a standalone node server, and, later, the channel sidecar" | `src/node/backend.ts` | The registry becomes the set of *leaves* a plan may name; the mount seam is how the channel hosts it. |
| `claudeDelegator`: one long-lived `query()` per delegator, turns serialized on `result`, `interrupt()` as cancel, in-process MCP server with `say/note/steer/app_list/app_call`, `alwaysLoad`, isolate | `src/claude/index.ts` | The `claude-sdk` leaf, unchanged in behaviour. Its brief (`CLAUDE_LIVE_BRIEF`) becomes the shared contract for both Claude leaves. |
| The channel: one process per Claude Code session, MCP over stdio, one HTTP+WS port, sidecars mounted by `mount(app, ctx)` with `ctx.port()` and `ctx.log`; the single push is `notifications/claude/channel` (`pushToSession(text, kind, meta)` in `commands/mcp.ts`), also reachable as `POST /prompt` | `packages/aiui-claude-channel/src/{sidecar,web-routes,commands/mcp}.ts`, `docs/architecture.md` | Channel mode = the live backend mounted as a sidecar. The wakeups rule (`docs/proposals/channel-wakeups.md` §3) allows a push that is "actionable by the model alone": a delegation is. |
| Page tools: the directory is a routing table addressed by tab; `page_tools_call` reaches a page's own tools | `packages/aiui-claude-channel/src/page-tools.ts` | In channel mode the interactive Claude drives the app through these; no `app_call` tunnel needed. |
| Hook events available to the plugin (repo root IS the plugin) | SDK `HookEvent`: `Stop`, `StopFailure`, `SessionEnd`, `UserPromptSubmit`, `PostToolUseFailure`, … | The abnormal-path notifier for channel mode (§4.3). |

## 2. Delegation trees

### 2.1 Nodes and spans

A **node** is one delegator handling one ticket. When a router node calls a child, it makes a
**child request**:

```ts
// src/plan.ts (new)
function childRequest(req: DelegationRequest, span: Span): DelegationRequest {
  const controller = new AbortController();
  req.signal.addEventListener("abort", () => controller.abort(), { once: true });
  return {
    ...req,
    signal: controller.signal,                     // cancel flows down, never up
    say:   (t) => req.say(t, { span: span.id }),   // appends carry the span
    note:  (t) => req.note(t, { span: span.id }),
    steer: (t) => req.steer(t, { span: span.id }),
    log:   (l) => req.log(l, { span: span.id }),
    span,                                          // the node's own handle (below)
  };
}
```

A **span** is `{id, parent?, ticket, name, kind: "leaf" | "router", startedAt, endedAt?,
status: "open" | "done" | "cancelled" | "failed" | "stalled", reason?, cost?}`. The engine
records `span.open` / `span.close` ledger entries; every `say/note/steer/log` entry gets a
`spanId`. `LiveTask` gains `spans: Span[]`. The root span is the ticket's own delegator.
The `backend` string on a task becomes derived: the path of leaf names that actually spoke
(`classify → claude-sdk`).

Two rules keep trees honest:

- **A router never speaks unless its plan says so.** Escalation lines ("let me look at the
  code") are plan knobs, spoken through the router's own span, so the ledger shows who said what.
- **A cancelled subtree may not append.** Enforced once, in the engine, by span status, the
  way a cancelled task already refuses appends.

### 2.2 Combinators

Four are enough to express everything discussed, and each is a few dozen lines over the seam:

| Combinator | Behaviour | Cancel semantics |
| --- | --- | --- |
| `classify(quick, slow)` | Run `quick` with one extra tool, `escalate(reason, brief)`. If it answers, done. If it escalates, speak the configured line, log the reason, and run `slow` with the brief and any tool results `quick` already gathered. | Cancel aborts whichever child is running. |
| `race(branches, pick)` | Start all; `pick: "first-speech"` (default) lets the first branch to call `say` win and cancels the rest before their first append; `"first-done"` waits for a result. Losers' appends are refused by span status. | Cancel aborts all. |
| `fallback(primary, then, timeoutMs)` | Run `primary`; if it fails or has not appended by the timeout, cancel it, log why, run `then`. | Cancel aborts the active child. |
| `sequence(steps)` | Run in order, each seeing the previous result as context. | Cancel aborts the active step. |

Leaves: `scripted`, `echo`, `responses`, `claude-sdk`, `claude-channel`. A leaf's plan node
carries its options (model, effort, tools, cwd, …), validated by the leaf's own zod schema.

### 2.3 The plan is data

```jsonc
// what the page sends; what the server echoes back compiled
{ "kind": "classify",
  "sayOnEscalate": "Let me look at the code for that.",
  "quick": { "kind": "responses", "model": "gpt-5.4-mini", "effort": "low" },
  "slow":  { "kind": "race", "pick": "first-speech",
             "branches": [
               { "kind": "claude-sdk", "model": "claude-sonnet-5", "effort": "medium" },
               { "kind": "fallback", "timeoutMs": 25000,
                 "primary": { "kind": "claude-channel" },
                 "then": { "kind": "responses", "model": "gpt-5.4", "effort": "high" } } ] } }
```

`compilePlan(plan, registry, ctx)` turns this into a `Delegator` tree. Unknown leaf names are
an error frame, not a silent default. Keys never appear in a plan: leaves resolve credentials
the way they do today (server env, CLI login). The compiled tree, with generated node ids, is
echoed in `ready` so the page can draw it before the first ticket.

## 3. Config from the page

- `hello` grows `plan?: Plan` (`delegator: string` stays as the one-leaf shorthand).
- A new client frame `configure { plan }` swaps the tree **between tickets**: an open ticket
  finishes on the tree it started with; the next ticket gets the new one. The engine already
  treats the delegator as swappable between tasks (`setDelegator`), so the browser-side
  `remoteDelegator` just forwards.
- The page's Bench gains a plan editor: presets (quick only, claude only, classify, race,
  fallback) plus knobs per leaf (model, effort, timeout, the escalation line), and a JSON view
  that is the truth. The tour page gets a chapter that renders the same editor against the
  simulator, so trees can be tried without a key.
- The server keeps the *registry* of leaves as its policy boundary: a deployment that does not
  offer `claude-channel` simply does not register it.

## 4. Claude Code two ways

### 4.1 `claude-sdk` (exists)

The relay owns a `query()` child process with the bundled CLI, an in-process MCP server for
`say/note/steer/app_list/app_call`, serialized turns, `interrupt()` as cancel, context kept
across tickets, isolation from the user's settings. Headless, reproducible, testable in CI.
Invisible except through the log lines the delegator emits, and it is a *different* Claude
from the one you are talking to in the terminal. Cost: the session's own tokens (the `result`
message carries `total_cost_usd` and usage; that becomes the span's `cost`).

### 4.2 `claude-channel` (new)

The interactive `aiui claude` session is the worker. The page on one side, the CLI on the
other, both watchable, and the human can type into the same session or break it.

**Where the backend runs.** The live backend becomes a **channel sidecar** (`aiui-live/node`'s
`handleHttp/handleUpgrade` mounted at `/live/*`, exactly the seam its header promises). One
port, one process, the same `ready/delegate/say…` relay the browser already speaks. The page
finds it the way the intent client finds the channel today. `demos/live` keeps its Vite-hosted
backend for the SDK-only path.

**The push.** `handle(req)` renders a delegation prompt and pushes it through the channel:

```
[live delegation item_ab12 from <tab url="…" title="…"/>]
user (recent): … / assistant: …
The user asked: "why does the trace go jagged when I raise samples?"
Report through the live tools. live_say speaks (≤ 500 tokens, paraphrased by the voice
model); live_note is a quiet fact; live_log is progress the page shows and never speaks;
call live_done(result) when finished or live_fail(reason). Every tool reply carries
{ cancelled: true } once the user has moved on: stop when you see it. Milestones, not
transcripts. Use page_tools_* to look at or drive the app.
```

This is the "custom prompt for the channel": rendered by the sidecar the way `intent-v1`
renders a lowered prompt, with the ticket id, the tab record, and the transcript window. It
passes the channel-wakeups rule because it is a real user request the model can act on. Push
mechanics: the sidecar POSTs its own `/prompt` (what the intent sidecar does today), or a small
`SidecarContext.push(text, kind, meta)` is added to avoid the HTTP hop. `kind: "live"` so the
console can tell these from intent prompts.

**The reply path.** Sidecar-registered MCP tools: `live_say`, `live_note`, `live_steer`,
`live_log`, `live_done`, `live_fail`, `live_status`. Today the channel's tool surface is
static plus the two page-tool meta-tools (`tools.ts`), so this needs one generic seam:
`MountedSidecar.tools?: SidecarTool[]`, merged into the MCP tool list at mount. The tools
resolve to the open ticket (one open channel ticket at a time per session; an explicit
`delegation` argument disambiguates), and the sidecar turns each call into the same relay
frame the SDK leaf produces. The alternative, declaring `live.say` as *page tools* and having
Claude call `page_tools_call`, needs no channel change but bypasses the relay, so the channel
leaf could not sit inside a tree. Sidecar tools it is (decision 1 in §9).

**Serialization.** One interactive session runs one turn at a time, and a push that lands
mid-turn is delivered only when that turn ends (§4.4). The leaf queues tickets and pushes
the next only after `live_done` / `live_fail` / a turn-ended signal. A queued ticket is a
visible span in state `queued`, so the page can say why nothing is happening, and the
span's `seenAt` is stamped by the first `live_*` call, the only proof the model read it.

### 4.3 When the human presses Ctrl-C

Two questions: what happens, and whose job is it to tell the page.

**What happens.** Interactive Claude Code aborts the turn; the tool call in flight, if any,
returns nothing, and the model produces no further tool calls. Nothing calls `live_done`.
The channel process stays up (it is the session's MCP server). Whether a hook fires on the
interrupt is the fact that shapes the rest; see the verified notes in §4.4.

**Responsibilities, in order of trust:**

1. **The model's job** is the normal path only: `live_done` or `live_fail`. Never rely on the
   model to report its own interruption.
2. **The plugin's job** is the abnormal path: hooks in the plugin (`hooks/hooks.json` at the
   repo root, since the repo is the plugin) POST `/live/turn-ended {event, session_id}` to
   the sidecar on `Stop` (whether it fires on an interrupt is undocumented, see §4.4),
   `StopFailure`, `UserPromptSubmit` (the human typed something else, so the ticket is
   abandoned) and `SessionEnd` (everything open fails with "session ended").
   The sidecar resolves an open ticket without a `live_done` as **abandoned**, and the page
   speaks a short line: "the agent stopped before finishing".
3. **The relay's job** is time: a ticket with no tool call for `stalledAfterMs` (default 30 s)
   moves to `stalled`, a *state*, not a failure. The page shows it, does not speak it, and
   offers Stop. This covers the case where no hook fires.

The engine gets the matching vocabulary: span status `stalled` and `abandoned`, both
distinct from `failed`, so the widgets and `explain()` can say the true thing.

### 4.4 Interrupt facts (checked against the docs, 2026-09-16)

Checked against `code.claude.com/docs` (hooks, channels-reference, mcp, agent-sdk/typescript)
and this repo's own measurements. Each fact ends with what the design does about it.

- **No interrupt-specific hook exists.** The hook list has `Stop` ("agent execution stop"),
  `StopFailure`, `SessionEnd`, `UserPromptSubmit`, `PostToolUseFailure` and others; none
  names a user interrupt, and the docs do not say whether `Stop` fires on Escape/Ctrl-C or
  only on a natural end. Hooks receive `hook_event_name` and no reason. → Measure once: a
  `Stop` hook that appends to a file, then press Escape mid-turn. §4.3 handles both
  outcomes: if `Stop` fires, the ticket is `abandoned` within a second; if not,
  `UserPromptSubmit` and `SessionEnd` still fire and the `stalled` timer covers the gap.
- **Cancellation of an in-flight MCP tool call is not documented.** Calls longer than two
  minutes are backgrounded; nothing says the server receives `notifications/cancelled`.
  → The `live_*` tools must return immediately: emit a relay frame, answer. They never wait
  on the page or on the voice model's ack. A blocking tool would be the one place an
  interrupt could leave the sidecar hanging.
- **A channel observes nothing about the session's lifecycle.** No turn start or end, no
  idle signal, no acknowledgement that a push was processed: `mcp.notification()` resolves
  when the bytes are written. A push that arrives mid-turn queues and is delivered at the
  next turn; the session does not wake mid-turn. → The channel leaf's `queued` state is
  real and invisible from the channel side until the first `live_*` call, which stamps the
  span's `seenAt`. The cancel push likewise lands only at the next turn, which is why every
  tool reply carries `cancelled: true` as well.
- **Push format.** `content` (string) plus `meta` (string values; each key becomes a
  `<channel>` attribute and must be an identifier). → `meta: { kind: "live", delegation:
  "item_ab12" }`, so the console can filter live pushes and the block names its ticket.
- **Agent SDK.** The installed SDK (0.3.272) has `Query.interrupt()`; measured here, it
  aborts the turn with a `result` of subtype `error_during_execution` and the query
  survives (`src/claude/index.ts` header). Whether `Stop` or `SessionEnd` hooks fire under
  the SDK is not documented; the SDK leaf does not need them, because the relay owns the
  process and sees its `result` messages directly.

## 5. Preemption

Three layers, each with its own switch, because the vendor separates them:

| Layer | Mechanism | Who can trigger it | What the doc says |
| --- | --- | --- | --- |
| **Backend** | `cancelTask(id)` → linked `AbortSignal` down the tree → leaves: SDK `interrupt()`, Responses `fetch` abort, channel: tool replies carry `cancelled: true` plus a cancel push (`[live delegation item_… cancelled]`) that lands as the next turn | page button, a spoken "never mind" (the router classifies it as cancel), supersede policy | "interrupting speech does not automatically cancel backend work" |
| **Speech** | `steer("Stop speaking immediately. Do not continue the last request. Wait.")` with `delegation_id: null` | page button, guardrails | instructions "can interrupt speech in progress"; the ack "does not prove that the assistant stopped speaking" |
| **Audio** | `TransportHandle.setOutputEnabled(false)`: pause/mute the WebRTC audio element, drop WebSocket audio deltas; clear queued audio before resuming | page button | "control output at the client or media relay: temporarily mute or drop the output, discard locally queued audio, send the corrective instruction, and resume playback" |

`LiveSession.stop(scope: "task" | "speech" | "all")` composes them; `LiveControl` gets one Stop
button (all) and the task strip gets per-ticket cancel. Voice barge-in stays the model's job
and needs nothing from us.

**Supersede or queue** is a session option, `onNewTicket: "supersede" | "queue"`, default
supersede: a new ticket cancels open ones through the backend layer and a steer line says the
earlier question was dropped. Under `queue`, the second ticket waits and its span shows
`queued`. The Claude leaves already serialize; this makes the policy explicit at the top.

**Channel-mode limit, stated plainly:** we cannot press Escape in the terminal from the page.
Cancel reaches the interactive session only at its next tool call or next turn. That is why
`claude-channel` should sit under `classify` or `fallback` but not inside a `race` (decision 4).

## 6. Visibility: four levels, one substrate

Everything below is a rendering of span-attributed ledger entries. Nothing is hidden at any
level; the levels decide what is *open by default*.

| Level | Question | Shows | Where |
| --- | --- | --- | --- |
| 0 | What is it doing? | One line per open ticket: leaf path (`classify → claude-sdk`), elapsed, the last log line, phase (`thinking`, `reading files`, `running add`, `speaking`, `queued`, `stalled`). Always visible. | `LiveTasks`, extended |
| 1 | Why is it slow? | The span tree with timings per node (to first append, tool rounds, child durations), the race outcome ("responses spoke at 1.2 s, claude cancelled"), the plan echo, the ticket's tool calls (Read/Grep/Bash names, page tools). One click. | new `LiveTree` |
| 2 | What broke? | The full ledger with raw events (exists), the relay frame log (new ring at `/live/debug/frames`, the shape of the channel's `frame-log.ts`), the SDK message stream for the ticket, the channel push text and hook posts, and **export**: one JSON per ticket under the project cache (`~/.cache/aiui/projects/<slug>/live/<ticket>.json`, next to the lowering traces) so the trace UI can render it later. | `LiveLedger`, console `/__aiui` |
| 3 | Where does the time and money go? | Per-node cost (SDK `total_cost_usd`, Responses usage, voice seconds), a waterfall across tickets, the `taskTimings` table. | `LiveLedger` cost fold, the tour's measured table |

Two precedents in the repo say this is the house style: the channel's frame log (parsed
JSON for small frames, byte counts for binary) and the lowering trace store (best-effort,
never on the prompt path). The delegation trace inherits both rules: exporting can fail
silently; the speech path never waits on it.

## 7. What the user sees end to end

1. Speaks. The voice model delegates; a ticket opens; the strip shows `classify` at 0.0 s.
2. The quick leaf answers a question about the page in 1.3 s, or escalates; the router speaks
   its one line and the strip shows `classify → claude-channel · queued` if a turn is
   running in the terminal, else `· thinking`.
3. In the terminal, the delegation prompt appears as a channel block. Claude reads code and
   calls `live_log("reading graph.ts")`; the strip updates; nothing is spoken.
4. Claude calls `live_say(…)`; the voice model paraphrases it. `live_done`. The span closes;
   level 1 shows the tree with 14.2 s on the Claude node, 0.6 s on the quick one.
5. Or the human presses Ctrl-C: a hook posts `turn-ended`; the span is `abandoned`; the page
   says the agent stopped. Or no hook fires: after 30 s the span is `stalled`, the strip shows
   it, and Stop is offered.

## 8. Rough code structure

```
packages/aiui-live/src/
  plan.ts                 Plan schema (zod), compilePlan(), childRequest(), the four combinators
  spans.ts                Span type, span ledger entries, LiveTask.spans, derived backend path
  session.ts              stop(scope), onNewTicket policy, span-aware append/record, setOutputEnabled
  types.ts                DelegationRequest gains { span, say/note/steer/log(text, {span}) }
  delegators/
    relay-protocol.ts     hello.plan, configure, stop; server: span, plan, stalled; span on say/note/steer/log
    remote.ts             forwards spans and stalled into the task; sends configure/stop
    responses.ts          unchanged except the escalate tool when run under classify
  claude/
    brief.ts              the shared brief (say/note/steer rules, 500 tokens, milestones) for both leaves
    sdk.ts                today's claude/index.ts, renamed; cost from result → span.cost
    channel.ts            claude-channel leaf: render push, queue, await live_done, cancelled flag
  node/
    backend.ts            leaf registry + compilePlan per connection; /live/debug/frames; POST /live/turn-ended
    sidecar.ts            the channel Sidecar: mount(app, ctx) → routes + sidecar tools (live_*)
    trace.ts              per-ticket JSON export to the project cache
  widgets/
    tasks.tsx             level 0 strip: path, phase, elapsed, last line
    tree.tsx              level 1: LiveTree
    ledger.tsx            level 2/3: spans, frames, cost
packages/aiui-claude-channel/src/
  sidecar.ts              MountedSidecar.tools?: SidecarTool[]; optional SidecarContext.push()
  tools.ts / server.ts    merge sidecar tools into the MCP tool list
  standard-sidecars.ts    add the live sidecar (channel depends on @habemus-papadum/aiui-live)
hooks/hooks.json          Stop / StopFailure / UserPromptSubmit / SessionEnd → POST /live/turn-ended
skills/aiui-workflow/     "live delegations": how to report, the 500-token rule, cancelled: true
demos/live/src/
  live/Bench.tsx          plan editor (presets + JSON), Stop button, LiveTree
  tour/                   a "delegation trees" chapter over the simulator
```

Milestones, each shippable alone:

1. **Spans.** Span ids on requests, ledger, relay frames; `LiveTree`; no behaviour change.
2. **Plans.** `compilePlan`, `classify` and `race` with the existing leaves; the Bench editor.
3. **Stop.** `stop(scope)`, the three layers, supersede/queue, per-ticket cancel.
4. **Channel mode.** The sidecar, sidecar tools, the push, hooks, `stalled`/`abandoned`.
5. **Traces and cost.** Frame ring, per-ticket export, cost per node.

## 9. Decisions to make

1. **Reply path in channel mode**: sidecar-registered MCP tools (recommended: the leaf composes
   in trees, the relay sees everything) versus page tools (no channel change, but the channel
   leaf cannot be a tree node).
2. **Where the channel-mode backend lives**: a channel sidecar (recommended: one port, the
   push is local) versus a standalone live server that POSTs `/prompt` to the channel.
3. **Plan editing surface**: presets plus a JSON view first, a full form later.
4. **`claude-channel` inside `race`**: disallow (recommended) until cancel can reach the
   interactive session mid-turn; allow under `classify` and `fallback`.
5. **Trace export location**: the project cache next to lowering traces (recommended) versus
   the live package's own directory.
6. **Cost of the `escalate` classification step** (one Responses call, ~1 s) versus a
   speculative start of the slow branch: default classify-first; `race` exists for the
   experiment.

## 10. Open questions

- Does `Stop` fire on a user interrupt in interactive Claude Code? Not documented (§4.4).
  The five-minute measurement decides how much of §4.3 rests on the `stalled` timer.
- Sidecar tools must be declared before the handshake. The channel's `tools/list` handler is
  evaluated per request (`tools.ts`), but Claude Code reads the list once after `initialize`
  and the channel deliberately keeps `listChanged` off, while sidecars mount only after the
  stdio connect (`commands/mcp.ts`). So the live sidecar declares its tool *schemas*
  statically and binds the handlers at mount; a call before mount returns "live sidecar not
  mounted". Verify the order once by watching the first `tools/list` in the frame log.
- How does a hook find the sidecar's port? The channel registry maps a session's pid and cwd
  to its port; the hook receives `session_id` and `cwd` on stdin, so a tiny `aiui live-hook`
  command can resolve it. Verify the hook payload carries what is needed.
- Two leaves speaking on one ticket in a `race`: the engine must refuse the loser's appends
  by span status *before* the winner's first `say` is acked, or the voice model hears both.
  The `first-speech` pick needs a local lock, not the ack.
- A spoken "never mind" mid-task: today it becomes a new ticket. The `classify` leaf can
  recognise it as a cancel of the open ticket, but the voice model may also answer it. Measure.
