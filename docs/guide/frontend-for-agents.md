# Frontend code for agents

The third layer of the project pairs naturally with [prompt lowering](./prompt-lowering) but
stands on its own: **principles, utilities, examples, and skills for writing frontend code that
AI agents write well, debug well, and iterate on fast**, aimed at scientific/technical
visualization. It began as an aspiration; it is now a working methodology with a library
(`@habemus-papadum/aiui-viz`), two reference apps (the morphogen and aztec notebooks in
`demos/gallery`), and a ledger of engineering findings.

This page is the **concepts** — what the pieces are and what we demand of them. Three companion
pages go deeper: [Design choices](./frontend-design-choices) explains, at
framework-designer level, exactly what we built and why; [Hard-won details](./frontend-hard-won)
is the ledger of paid-for technical knowledge underneath it; the
[Style guide](./frontend-style-guide) is the authoring conventions — page structure, TOC,
plotting, math — that make every notebook in a lab read as one publication.

If you just want to *use* the library — write a cell, depend on another cell, stream a computation,
display it — start at the [User guide](./frontend-user-guide) instead; when you're building a whole
app, the [Playbook](./frontend-playbook) sequences the work. Both assume none of this page.

## The premise

Agents write most of the code; a human stays in the loop, watching and steering, pointing at the
running app and saying "make *this* wider." Three consequences shape everything:

1. **The app must be legible to the tools an agent debugs with** — a screenshot, a console, an
   evaluated expression. Instrumentation is not overhead; it is what makes the pairing loop and
   [prompt lowering](./prompt-lowering) work at all.
2. **The code may be more explicit than a human author would enjoy** — richer chrome, denser
   instrumentation, schemas next to logic. Agents don't get bored. The hard constraint is that it
   stays *readable*, because the human still reviews and steers.
3. **The running state is precious.** The loop edits the very app being inspected. A human drives
   the app into an interesting state — a simulation grown for minutes, a bug reproduced — and the
   agent edits code underneath it. Edits must not reset that state.

## The concepts

### Cells: async dataflow as the structure of the app

Scientific UIs are full of computations that take time — worker jobs, fetches, long transforms —
with dependencies among them. We structure them the way an Observable notebook does: as a graph
of **cells**. A cell is one asynchronous value with everything its consumers need attached: it
recomputes when inputs change, *holds* until its inputs are ready, streams partial results,
reports progress, keeps its last good value visible while a new one computes, carries an
`AbortSignal` so superseded work actually stops, and exposes a small state machine
(`pending · streaming · refreshing · ready · errored`) for UI chrome.

Two ideas inside this deserve their own names:

- **Streaming is the default.** A downloading table fills in packet by packet; a worker posts a
  cheap partial seconds before its expensive final answer. Consumers choose per-use whether they
  want every partial or only settled runs.
- **Cancellation is supersession.** There is almost no explicit cancel plumbing. Moving a slider
  invalidates the in-flight run; the graph aborts it (and the worker really stops) and starts the
  next. Even the explicit "cancel" button is just "hold this cell until further notice."

The substrate is SolidJS 2.0 (beta), whose async-first reactive core absorbed most of what this
model needs — the archived solid-cells design notes (`archive/reactive-flows/` in the repo) trace
that history. The code reads as mainstream TypeScript, not a notebook dialect.

### The durable/disposable line: why edits don't destroy state

The single most consequential structural rule: every piece of the app is explicitly either
**durable** (survives a code edit — the WebGL field textures, the running worker, accumulated
history, and above all the user's interaction state) or **disposable** (recomputed freely —
render functions, cell computes, shaders, chart options). The line is drawn *in the module
layout*, so hot-module-reloading has an easy job: durable things live in a registry that
re-evaluating modules **adopt rather than recreate**; disposable things rebuild from the durable
roots on every edit.

The reframe that makes this coherent: **a code edit is just another cause of invalidation** — the
same machinery that recomputes a cell when a slider moves recomputes it when its compute function
changes. In the reference apps this is real: editing a GLSL shader recolors a running simulation
without resetting the field; editing the dataflow module rebuilds every cell while sliders,
history, and the sim carry on; and each hot swap logs what it preserved, so the reload itself is
observable.

### Legibility: from a pointing gesture to code

When a human points at the running app, the tooling must answer two different questions:

- **"Which code *authored* this element?"** — solved by compile-time stamping: every rendered
  element carries `data-source-loc="src/ui/Controls.tsx:81:9"`.
- **"Which computation *produced* this value?"** — solved by cell attribution: elements that
  render a cell's value carry `data-cell="analysis"` (plus `data-cell-loc`, the cell's
  definition site), and a live registry maps cell names to their state and definition site.

Together they turn "make *this* wider" into a file, a line, and a dataflow node — without the
scientific code carrying any affordances for it (identity is injected at compile time; the
attribution boundary comes free with the standard cell-rendering wrapper). The contract is
deliberately framework-neutral: two DOM attributes plus a registry, however a given stack
implements them.

### The tool surface: the app grows verbs for the agent

As features are built, the app accumulates **tools** — named, described, schema'd operations an
agent can discover and call (`window.__morpho.call("jump-regime", { id: "mitosis" })`), plus one
bounded `report()` that snapshots the whole app. Tools are registered *next to the feature that
implements them*, ImGui-style, so the surface grows with the code instead of being a manifest
maintained elsewhere. This is the WebMCP direction: ultimately these registrations flow through
the dev overlay to the channel and appear to the agent as first-class tools. In practice the tool
surface is also how the agent *verifies its own work* — the reference apps were tested end-to-end
through their own tools.

### The imperative boundary: who called this function?

The one piece of vocabulary the rest of this methodology quietly depends on. Solid 2.0's write
contract is transactional: a `set` *stages* a value, the commit happens at the next microtask,
and **the reactive graph is the only reader of your writes**. So every function in an app is in
exactly one of two worlds, and the test is a single question — *who called it?*

- **Solid called it** → you are **inside the graph**: a memo's compute, an effect's *compute*
  function (the first argument), a JSX expression, a cell's `deps` thunk. Reads here are
  tracked, see a consistent staged snapshot, and are always safe. Writes here throw (in dev).
- **Anything else called it** → you are at an **imperative boundary**: the browser fired an
  event, a timer or socket delivered, the MCP dispatcher invoked a tool's `run`, a rAF tick
  landed. Writes here are allowed but staged; reads here return the last *committed* value —
  **not what you just wrote**, and a memo over what you just wrote is exactly as stale.
  (`getObserver()` from `solid-js` is `null` precisely here, if you're ever unsure. Being
  lexically inside a component changes nothing: the component *body* is graph; the `onClick`
  handler it creates is boundary.)

Boundary code therefore follows two rules, one per direction. **Inbound** (world → graph):
never read back what you just wrote — branch on the local you computed or on the setter's
return value; where a flow genuinely must observe its own writes (a state-machine dispatch),
wrap it in `flush(fn)`, which commits synchronously. **Outbound** (graph → world): push
reactive values into non-reactive things (a canvas, a worker, an imperative widget) through a
two-arg `createEffect(() => derive(), (value) => push(value))` — the graph calls the push;
nothing is hand-called, so nothing can be forgotten. The two rules are one mechanism:
`flush(fn)` also runs effect handlers before it returns, so a committed dispatch leaves state,
derived values, *and* every effect-driven surface current by its next line. The full ledger
entry (with the seven live bites that paid for it) is in
[Hard-won details](./frontend-hard-won); the contract itself is pinned by
`packages/aiui-viz/src/solid-semantics.test.ts`.

The reference implementation of a correct inbound crossing is the intent client's activation
gesture (`packages/aiui-intent-client/src/activation.ts`): a vanilla listener walks a state
machine with sequential, idempotent dispatches, **re-reading committed state between steps** —
which is safe precisely because the mode engine (next section) commits every dispatch under
`flush` and keeps machine state as a plain frozen object. Machine state under the mode engine
is never stale to read, from any scope — the structural fix for the write-then-read-back trap.

### The mode engine: settings, operations, and one writer

When an app grows real modes — arming, open turns, talk windows, standing toggles — the
methodology's answer is the mode engine (`createModeEngine` in `aiui-viz/modal`,
framework-free; `solidModeEngine` is the Solid adapter), built on one clarifying split: every
"mode" is a **setting** (what the user chose — standing, often durable, often agent-visible)
and an **operation** (what the world is doing about it right now — derived, transient, async).
Settings live in **regions** — named independent axes (ladders, toggles, choices) whose product
is the state, so orthogonality is by construction. Operations are **claims**: pure derivations
from (state, context) that a reconciler drives, each with a derived status
(idle · pending · active · error · stale) — the "granted but idle", "warming", "on but not
sampling" states are the *status of an operation*, displayed but never stored in ad-hoc flags,
with supersession built in (the newest desire wins, even when it is null).

**Commands are the only writers.** Keys, command-bar caps, the agent's `set`, and system events
all funnel into `dispatch` — one pure reducer plus declared cross-region **excludes** ("leaving
the turn ends talk"), applied after every command *and to the initial state*, so a durable
value can never resurrect a forbidden combination; Esc and blur resolve mechanically from the
spec. Because nothing else writes, availability is *derived*: `canDispatch` dry-runs the
reducer ("would this do anything right now?"), and the command bar is a pure projection of the
spec — a tree flattened into depth rows, labels stable (the lit highlight carries "engaged"),
enablement mechanical rather than hand-written per surface. The Solid adapter completes the
contract: dispatch commits under `flush()`, so state, memos, and every effect-driven projection
are current when it returns; and regions marked `agent:` register a `control()` whose setter
dispatches — the agent's write and the key take the identical path, which structurally kills
the control-mirror desync class.

The deep rationale — including what was deliberately left out (entry/exit effects, history
states, XState) — is `docs/proposals/intent-client/01-mode-engine.md`; the worked example is
the intent client's spec (`packages/aiui-intent-client/src/spec.ts`): a real machine as one
data structure — regions, commands, excludes, the Esc order, and availability overrides.

### Many notebooks, one lab

Real practice is a collection of explorations — separate pages with nav, VitePress-style. And
each page reads like a short paper, not a dashboard: sections that interleave the interactive
laboratory with prose, real mathematics, a theory of what's on screen, and an "experiments"
section of concrete things to try — navigable through a right-hand table of contents, under a
shared header that makes the *collection* visible. Pages respect the system's light/dark
preference; simulation canvases stay self-contained dark figures in both. The supported shape is
a **single-document shell**: lazy page modules behind client-side routing, with heavy islands
declaring suspend policies (pause / hibernate / dispose) — the durable/disposable line applied at
page granularity, pause-not-destroy by default. One document is not just a resource choice: it is
what lets an agent-collaboration turn (the intent tool's open thread, its socket, its capture
grant) survive switching notebooks, with each switch traced as a navigation event. The older
pattern — separate Vite entries, a full page load per notebook — frees resources by construction
but kills that continuity, which is why the gallery migrated off it. Coordination stays boring:
URL for shareable state, localStorage for preferences, BroadcastChannel across tabs.

## The weaving challenge

None of these is exotic alone. The challenge — and the actual design work — is that they are all
the *same* structural decisions viewed from different sides. Named nodes serve attribution *and*
HMR identity *and* auto-derived tools. The durable/disposable line serves state preservation
*and* page lifecycles *and* worker ownership. Boundaries (the cell-rendering wrapper) serve
loading chrome *and* attribution stamps. A framework that weaves them means the scientific code —
the part a human most needs to read — stays clean: define parameters, define cells, render
values. Everything else is injected, adopted, or derived.

## What agents get to do that we wouldn't ask of humans

Worth naming, because it changes the design targets: an agent will happily register a tool and a
reporter beside every feature, thread progress callbacks through every long computation, keep
observability chrome on every async value, write the one-line attribution affordance every time,
and verify its work by driving the app through its own tool surface. Designing *for* that
diligence — making each of those a one-liner with a convention — is what makes the resulting app
better instrumented than a human team would ever bother to make it.

## Where things live

- **Library** — `@habemus-papadum/aiui-viz` (`packages/aiui-viz`): cells, the CellView wrapper,
  the worker protocol, the durable registry, the tool surface, and the modal kit + mode engine
  (`src/modal/`; the Solid adapter is `src/mode-solid.ts`).
- **Reference apps** — `demos/gallery`: morphogen (reaction-diffusion) and aztec (domino
  tilings), each a full notebook built the intended way; `PRINCIPLES.md` there maps file layout
  to methodology.
- **Mode-engine reference** — `packages/aiui-intent-client`: the first full consumer — the
  machine as data (`src/spec.ts`), claims (`src/claims.ts`), bar caps (`src/caps.ts`), the
  imperative-boundary reference (`src/activation.ts`); `BEHAVIOR.md` records the decided
  interaction contract, each rule pinned by a test.
- **Design choices** — [the level-2 page](./frontend-design-choices); **ledger** —
  [the level-3 page](./frontend-hard-won).
- **Skill** — the `frontend-design` Claude plugin
  (`packages/aiui-claude-plugin/marketplace/plugins/frontend-design`) teaches this to a coding
  agent; the docs here are its source of truth.
- **Background notes** — the pre-implementation explorations (solid-cells, HMR for agentic
  coding, agentic frontend debugging, observable web workers) are retired to the repo's
  `archive/` folder; these pages are their distillation.
