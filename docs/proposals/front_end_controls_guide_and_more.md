# The control surface, the reflection registry, and the compiler-pass framework

## Context

The frontend methodology now has pure functions → cells → components → application (the
playbook), but it is missing its **control surface** as a first-class concept: the writable
signals a user manipulates through widgets and an agent should manipulate through tools. Today
that surface exists physically (`durableSignal`s in `store.ts`, two-way-bound in `Controls.tsx`)
but is not *reified* — no registry, no descriptions/constraints, and every knob costs ~20 lines of
hand-written `get-params`/`set-params` tooling with clamping duplicated between widget and tool.

Meanwhile cells already have the whole apparatus (babel-injected names/locs, `cellRegistry()`, the
`cells` reporter, `data-cell` stamps). This plan closes that asymmetry, extends the registry into
a **reflection layer** covering controls, actions, cells, and live views (with dependency edges),
and generalizes the one-off babel pass into a small, principled compiler-pass framework. Then: a
step-by-step walkthrough demo (1-D diffusion), and docs (user guide → playbook → skill), in that
order.

**Philosophy constraint (Nehal, explicit):** no magical auto-control frameworks. The registry and
annotations exist to give an agent an *efficient starting point* — read the surface, the states,
the dependency topology — before diving into code it fully controls. Repeated interaction
patterns (a slider with units and a tiny preview visualization; an adjustable plot) become
**porcelain components extracted once proven in real apps**, exactly like the Plot and Mosaic
bridges — never a generated panel. Controls belong woven into the document's prose, not in a knob
drawer.

## The conceptual model (settled)

- **Signal** = a box someone writes; the only way time enters. **Cell** = a formula that is never
  written (a Solid memo dressed for reality). Independent vs derived variables.
- **`control(name, initial, meta)`** = a *curated, annotated* durable signal: the app's writable
  frontier. **`action(name, run, meta)`** = a registered verb (capture, reseed) — not a value.
- Declare once → the projections: hand-designed UI widgets bind it, keyboard/modal bindings
  (later) dispatch its actions, and the agent's tools are derived from it. Plain
  `createSignal`/`durableSignal` remain for un-surfaced internals — the surface is curated.

## 1 · The reflection registry (aiui-viz)

One registry, four entry kinds, all carrying `name`, `description?`, `loc?` (definition site):

| kind | writable | contents |
| --- | --- | --- |
| `control` | yes (validated) | current value, meta (min/max/step/options/unit), backing signal |
| `action` | invoke | run fn, arg schema from meta |
| `cell` | no | state, settled, value summary — *exists today* (`cellRegistry`), gains `description?` via `CellOptions` |
| `view` | no | enumerated **live from the DOM** on demand: elements carrying `data-cell` / `data-control` / `data-source-loc` stamps — never stored, can't go stale |

**Dependency edges (controls→cells, cells→cells) — runtime, exact, no Solid internals.**
`cell.ts` calls `deps()` at exactly two sites (`packages/aiui-viz/src/cell.ts:164` and `:250`).
Wrap those in a module-global `currentConsumer = <cell name>`; `control.get()` and the cell read
path record `(consumer, dependency)` edges when the global is set. Edges refresh per recompute
(report the latest run's set). This is the cheap, robust alternative to the cell-attribution
spike's pinned-internals approach, and it is what lets an agent read the app's dataflow topology
without source spelunking — while `loc` on every entry still points at the code when it wants to
dig deeper.

**Derived standard tools** — `registerStandardTools` grows from 2 to the full control interface:

- `report({ format?: "brief" | "full" })` — the assembly: controls (name→value; full adds
  meta/loc/description), cells (name→state; full adds value summary/loc/description), edges
  (`control → [cells]`), views (from the DOM), plus app-registered custom reporters as today.
- `set({ name, value })` — look up control, validate/clamp against meta **in one place**, write,
  return what was written (the batching rule finally lives in the library).
- `invoke({ name, args })` — run a registered action.
- `locate` — unchanged.

Hand-written tools remain for the genuinely bespoke; the template's ~40-line
`get-params`/`set-params`/reporter scenery dissolves entirely.

**API sketch** (final signatures at implementation):

```ts
// store.ts — layer 2 opens by declaring the control surface
export const kappa = control("kappa", 0.1, {
  description: "Diffusion coefficient", min: 0.01, max: 1, step: 0.01,
});
action("re-seed", () => reseed(), { description: "New initial condition; profile recomputes" });
```

Decisions made: **explicit name** (it is the durable key and tool identity — the app must work
with the compiler pass off, so only `loc` is injected, never the name); `control()` implies
durable; validation policy (`clamp` default for ranges, error on type mismatch) lives in meta.

**Widget patterns — extraction, not generation.** No `<ControlPanel/>`. Apps hand-design their
bindings (today's two-line pattern: `value={c.get()}` / `onInput={… c.set(…)}`). Candidate
porcelain, *recorded during the walkthrough/gallery work and extracted only once a pattern repeats
and stabilizes*: a control-bound slider that renders label/units/constraints from the control's
meta and hosts a **tiny preview visualization** (possibly live on the uncommitted drag value,
committing to the signal on release); an "adjustable plot" macro-pattern. Whatever binds a control
stamps `data-control="<name>"` — completing attribution symmetry (drag over a slider resolves to
the control and its definition site, exactly as drag over a chart resolves to the cell).

## 2 · The compiler-pass framework (aiui-dev-overlay)

`source-locator.ts` already embodies the paid-for findings (one babel pass in `Program.enter` +
explicit traverse because preset-solid replaces JSX subtrees; standalone Vite plugin
`enforce: "pre"` because vite-plugin-solid never sees `.ts`; content sniff; dev-only). The change
is to make its call-site half **table-driven** instead of cell-specific:

```ts
interface FactorySpec {
  callee: string;             // "cell" | "control" | "action" | consumer-defined
  args: { min: number; max: number };
  optionsArg: number;         // which arg receives/holds the injected object
  inject: ("name" | "loc")[]; // cell: both (inferred name); control/action: loc only
}
```

- One generic `CallExpression` handler consumes the table; the sniff regex is built from it.
- Config: `aiuiDevOverlay({ locator: { factories: [...] } })` with `cellFactories` kept as
  back-compat sugar. Defaults: `cell` (name+loc), `control`, `action` (loc).
- **Principles codified in the module header** (the compile/runtime split): compile-time injects
  *identity and location only* — behavior must never depend on the transform (prod builds and
  plugin-off must work: cells go anonymous, controls keep their explicit names and lose only
  `loc`); injection is idempotent (existing keys respected); naming is syntactic (aliased
  factories invisible — a documented 90% heuristic); everything behavior-relevant (registries,
  dependency edges, validation) is runtime.

## 2a · The aiui compiler: ratified design (2026-07-10)

Section 2 sketched the table-driven pass as a dev-only convenience. That framing is now
superseded. Three decisions are ratified.

**1 · The compiler is load-bearing, and runs in both BUILD and SERVE.** The identity/description
injection pass is no longer dev-only. Once `control({ value })` derives its name from the
assignment binding — and that name is simultaneously the durable-persistence key and the
agent-tool identity — the transform is *semantically required*, not a debugging affordance.
Production builds without the plugin must therefore fail **loudly at runtime**: a `control()` that
reaches runtime with no name throws `control() needs a name — either the aiui compiler plugin or
an explicit { name }`. Never silently anonymous. This inverts §2's "cells go anonymous, prod must
work with the plugin off" stance *for the identity pass specifically*: named controls are the
default authoring form, so their name is not optional. Requiring a compiler is a normal framework
shape — Solid, Svelte, Qwik, and the React Compiler all do it. Only the JSX `data-source-loc`
stamping half stays dev-only (`apply: "serve"`).

**2 · JSDoc is the description convention.** Descriptions for controls, cells, and actions are
lifted at compile time from the leading doc comment immediately above the declaration
(`/** Diffusion constant */`). Babel attaches both `/** */` and `//` leading comments, so both are
accepted, but the *documented* convention is JSDoc because it does double duty: the same
characters render as an editor tooltip and as the runtime registry description. An explicit
`description` in the options object always wins over the lifted comment.

**3 · Cells keep their positional signature; controls and actions take a single options object.**
`cell(deps, compute, opts?)` stays — deps/compute-positional is the notebook idiom, cells already
get name inference, and they only *gain* a comment-lifted `description` in `CellOptions` plus the
literal check. Controls and actions move to the single-object form:
`control({ name?, value, description?, min?, max?, step?, unit?, options? })` and
`action({ name?, description?, run })`. The convenient form omits `name` (the compiler infers it
from the binding); the pedantic form states it. The pedantic form is also the documented escape
hatch for **renaming a variable without resetting its durable key**: because the inferred name
*is* the durable key, changing the binding silently rotates persisted state — stating `name`
explicitly pins the key while the variable is free to change.

**Viability was proven by probe** against the repo's `@babel/core` (2026-07-10). Name inference
works both for `export const kappa = control(...)` (walk to the `VariableDeclarator`, then hop the
`ExportNamedDeclaration`) and for object properties (`profile: cell(...)` inside a graph builder —
`leadingComments` attach to the `ObjectProperty`). Doc-comment lifting works for both comment
forms at both positions because the pass runs `enforce: "pre"` against the *original* source.
Literal verification is a single AST-type check (`StringLiteral` vs.
`BinaryExpression`/`TemplateLiteral`/`Identifier`), and `path.buildCodeFrameError` yields
compiler-quality diagnostics that surface as Vite's red dev overlay (or a failed build).

**Why babel-in-our-own-Vite-plugin remains the answer** (compilation-stage survey):

- **TypeScript compiler plugin — not a real option.** `tsc` is not in the serving path (Vite
  strips types with esbuild; `tsc` runs only as the `noEmit` typecheck gate, so a tsc transformer
  would transform code that never ships), and TypeScript exposes no official transform-plugin API
  (`ts-patch` literally patches the compiler; language-service plugins affect only editors). Using
  the TS compiler API purely as a *parser library* inside a Vite plugin is viable but buys nothing:
  everything we need (binding names, leading comments, literal-ness) is syntactic, and the one
  unique TS asset — the type checker — would drag whole-program analysis into a per-file dev-server
  transform hook.
- **esbuild plugins — no AST hooks** (string-in/string-out `load`/`resolve` only); you would bring
  your own parser regardless.
- **SWC — plugins are Rust/WASM against an unstable ABI**; the wrong trade for a framework whose
  compiler agents should be able to edit.
- **oxc/rolldown — Vite's future**, promising JS-authored transform hooks; watch it, don't bet on
  it yet.
- **Babel inside our standalone Vite plugin (current)** — the paid-for findings keep it right:
  vite-plugin-solid never transforms plain `.ts` (where the dataflow lives); preset-solid's
  traversal swallows JSX subtrees (hence `Program.enter` + an explicit `path.traverse`);
  `enforce: "pre"` sees original source with comments; the content sniff bounds double-parse cost.

**The restructure.** `source-locator.ts` is promoted to *the aiui compiler*: one shared parse per
file feeding a **table of passes**. Each `FactorySpec` declares its callee, argument arity,
options-arg index, what it injects, and an `apply: "serve" | "build" | "both"` — identity/description
injection is `"both"`, JSX stamping is `"serve"`. A diagnostics channel lets any pass throw
code-framed errors. Future passes (WebMCP form annotations, etc.) plug into this table instead of
accreting as new one-offs.

**Verifier rules** (each a compile error with a code frame): (1) an explicit `name` must be a
string literal — dynamic names are rejected because the name is a durable key, a tool identity, and
a grep target for agents; (2) the convenient form requires an inferrable binding — a `control()`
not assigned to a named binding errors, pointing at the pedantic form; (3) cross-module duplicate
names are invisible to compile time, so the **runtime** registry throws on collision at
registration; (4) injection is idempotent (existing keys respected) and happens at the transform
stage, making it immune to minifier renaming.

## 3 · The walkthrough demo: 1-D diffusion (`demos/walkthrough`)

A heat/diffusion profile evolving in time — the best streaming/cancellation showcase — built **as
the playbook, step by step, with every step left standing** using the gallery's multi-entry
pattern (one Vite input per step), so each stage is a page CI typechecks and tests forever:

- `step1.html` → layer 1 only: pure functions (initial conditions, one explicit diffusion step,
  analytic reference solution, error norms) + exhaustive tests + a `bench`; the page renders a
  static profile.
- `step2.html` → the control surface + cells: `control()`s (κ, dt, resolution, initial-condition
  choice), an `action` (re-seed), a **streaming stepping worker** (frames yield as computed;
  moving κ cancels and restarts — the full supersession story), minimal hand-rolled bindings, and
  the derived tools live (`report`/`set`/`invoke` drivable from the session).
- `step3.html` → designed layer-3 components: the profile plot, a space-time heatmap, controls
  woven into explanatory prose (the anti-panel statement in action). Porcelain candidates get
  noted here, not invented in the library first.
- `index.html` → the finished layer-4 app: paper-style sections, keyboard bindings dispatching
  the registered actions.
- `WALKTHROUGH.md` narrates each step and the diff between steps.

## 4 · Multi-client (decision deferred, analysis recorded)

Nothing in phases 1–4 depends on it: derived control tools are ordinary page tools, so they
inherit the existing model — registrations keyed by `(clientId, ns)`, dead sockets pruned on
close (`packages/aiui-claude-channel/src/web.ts:473`), `page_tools_call` errors listing candidates
on ambiguity, tab hints on each registration. When the decision is taken up, the recorded options
are: keep multi-client + add a focus/visibility hint (overlay reports it; directory prefers a
uniquely-focused tab on ambiguous calls) + one documentation home for the multi-client model
(likely `docs/guide/multi-view-sessions.md`), vs. one-client-per-session. No work now.

## 5 · Documentation & skill (strictly after the code works)

Order per Nehal: **user guide** (new step between "a box that notices" and cells: *declaring the
control surface*; `report`/`set`/`invoke` in the agent step; the philosophy note — annotations are
the agent's starting point, code is the destination) → **playbook** (layer 2 formally opens with
the control surface; DoD gains "every control described + constrained; set→observe round-trips";
walkthrough demo referenced as the worked example) → **frontend-design skill**
(control/action/registry/derived tools replace "write a tool twin per operation"; the
no-auto-magic philosophy stated). Template scenery migrates to `control()`/`action()`; gallery
morphogen adopts controls where natural.

## 6 · Pixel→cell attribution: resolved (2026-07-10)

Pixel→cell attribution is supported **by declaration only**. The runtime-internals spike is
retired, and compile-time JSX read detection is rejected. Two paths, one principle:

- **The free path.** `CellView` stamps `data-cell`/`data-cell-loc` as a free rider on the
  loading/error/keep-latest chrome the methodology already mandates — no new authoring burden.
- **The declared path.** For renders outside `CellView`, one manual `data-cell="name"` attribute.
  It is a *name*, not a location, so it cannot drift. Failing to write it is only a false negative,
  and even then the element still carries the compiler-injected `data-source-loc`, leaving an agent
  one file-read from the answer.

The clean division of ownership: **the compile-time layer owns LOCATIONS, declarations own
IDENTITY, runtime owns LIVE STATE AND TOPOLOGY** (the registries and dependency edges). The spike
failed precisely because it made runtime own *identity*.

**Evidence that drove the decision.** The spike (`cell-attribution.ts`,
`enableCellAttribution`/`attributedRead`) had **zero consumers** — only its own file, test, and
barrel export referenced it. Real component idioms read cells *non-lexically*
(`const census = () => analysis().latest()` in component logic; cells feeding Plot option thunks),
so a false-positive-*safe* syntactic rule would catch approximately nothing, while a loose rule
would manufacture false positives — worse than false negatives, because they actively mislead the
agent. Meanwhile the manual `data-cell` attribute was already in organic use by agents following
the skill (the gallery's `StatsTiles`, seismos' `StatTiles`).

**Actions taken.** `cell-attribution.ts`, its test, and its exports were deleted;
`docs/proposals/solid-cell-attribution.md` was marked *retired* with the outcome recorded; and the
shot locator's cell-source ladder gained **registry-backed resolution** — a bare `data-cell` name
resolves to its definition site via a small `window` bridge to the live cell registry, exact by
construction. That delivers everything the spike promised at zero brittleness.

## Implementation phases

**Phase 1 — primitives + registry + derived tools (aiui-viz).** `src/control.ts` (control /
action / registries / edge capture — the consumer hook added at cell.ts's two `deps()` sites),
`standard-tools.ts` (report/set/invoke), `CellOptions.description`, unit tests (validation, edge
capture across recomputes, report formats), README + docblocks. Gates: viz suite, packaging.

**Phase 2 — compiler-pass framework (aiui-dev-overlay).** Table-driven `source-locator.ts` +
`FactorySpec`, back-compat `cellFactories`, sniff from table, loc injection for control/action,
principles in the header; extend `source-locator.test.ts`. This phase implements §2a (the ratified
compiler design — load-bearing identity/description injection, `apply` stages, verifier rules).

**Phase 3 — template + gallery adoption.** Template scenery on `control()`/`action()` (hand tools
deleted; fences keep their shape so the reset e2e stays green); morphogen params → controls.

**Phase 4 — walkthrough demo.** As §3; porcelain candidates recorded in WALKTHROUGH.md, extracted
to aiui-viz only if/when they prove out (a later, separate decision).

**Phase 5 — docs + skill.** As §5. Multi-client remains parked per §4.

Phases 1–2 are the detailed "first couple of steps"; each phase ends with the standard gates
(lint / `pnpm -r typecheck` / full tests / packaging when exports change / docs build /
skills:check / template e2e).

## Verification

- Unit: registry + edge-capture + validation tests in aiui-viz; locator table tests.
- E2E: template e2e (scaffold → test → reset) stays green through Phase 3; walkthrough demo pages
  typecheck/test in CI (demos/* vitest projects).
- Live: drive a scaffolded app via the derived tools through `page_tools_call` in a real session —
  `report` brief/full, `set` a control, watch the dependent cell recompute and the edge appear,
  `invoke` an action.


## Phase 1 implementation notes + documentation debts (2026-07-10)

Phase 1 is BUILT (aiui-viz: `control.ts`, `graph-trace.ts`, extended
`standard-tools.ts`/`testing.ts`/`cell.ts`; 14 new unit tests; verified end-to-end in a throwaway
dogfood demo — compiler-named controls drove a cell, `set` clamped through the control's meta, the
production bundle carried `name/loc/description`, then the demo was deleted). Deltas from the plan,
and the notes for the deferred documentation pass:

**Design deltas (document these, they differ from the plan text):**
- There is **no generic `invoke` tool**: each `action()` IS a real named agent tool (own
  description, params/inputSchema), registered by `registerStandardTools` and kept in sync through
  `subscribeControlSurface` — declaration order never matters, and an HMR re-declaration swaps the
  implementation late-bound behind the same tool name.
- Control/action registration is **replace-by-name** (HMR-safe), with a console.warn when the
  incoming `loc` differs from the existing one (the genuine-collision signature). The plan's
  "throw on collision" was HMR-hostile.
- Validation policy shipped: type mismatch and enum violations THROW; min/max CLAMP; `step` snaps
  (anchored at `min`, float-cleaned to the step's decimals). One path — widget `set`, keyboard,
  and the agent's `set` tool all go through it. `set` accepts updater functions.
- Durable keys are namespaced `control:<name>`.
- `report` tool: `format: "brief"` (default; compact maps + `edges` as `"kind:name"` strings) |
  `"full"` (entries with description/loc/meta). Custom reporter sections ride along in both.
- Edges: deps-only attribution (compute reads deliberately unattributed — same rationale as
  Solid's own untracking); anonymous cells record nothing; a cell's edges drop with its owner;
  `gateNow`'s internal deps re-read is attribution-suspended so outer cells aren't blamed.

**Documentation debts (for the post-demo doc pass):**
1. User guide: new step *"declaring the control surface"* (control/action, convenient vs pedantic
   form, JSDoc descriptions, validation semantics, rename-resets-state rule) + update the agent
   step for `report`/`set`/per-action tools + testing step gains `resetControlSurface` (controls
   are module-and-window state; `afterEach(resetControlSurface)`).
2. **Vitest needs the compiler too**: tests exercise inference, so app vitest configs must include
   `aiuiDevOverlay({ locator: true, mount: false })` (dogfood-proven). Template's vitest.config.ts
   should ship this when the template adopts controls (Phase 3), and the user guide's testing step
   must call it out.
3. Widgets read bounds from `control.meta` (the dogfood Controls.tsx pattern) — the anti-duplication
   story for the porcelain discussion; `data-control` stamping still unimplemented (porcelain phase).
4. Playbook: layer 2 opens with the control surface; DoD gains "every control described +
   constrained; set→observe round-trips; edges present in report".
5. Skill: control/action/registry/derived-tools replace "write a tool twin per operation";
   replace-by-name + loc-warning semantics; `resetControlSurface` in the DoD test guidance.
6. aiui-viz README: control surface + graph-trace rows in the export table; testing row gains
   `resetControlSurface`.
7. attribution.md: cells table row gains `description`; note `report(full)` as the fourth
   resolution surface (name → description/loc without DOM).
8. `cellHarness` anti-pattern found in dogfooding: cells must be CREATED inside the harness's
   setup (outside → Solid's NO_OWNER_BOUNDARY warning, boundary never disposed). Document in the
   harness docblock and the testing step.
9. Template/gallery adoption (Phase 3) still pending: template scenery → control()/action() with
   `locator: true` defaults; delete its hand-written get-params/set-params; gallery morphogen
   params → controls where natural.


## Phase 3 notes: adoption + the first earned porcelain (2026-07-10)

Template and gallery now declare their surfaces. Template: scenery params are convenient-form
`control()`s (doc comments → descriptions), one `action("re-flower")`, `locator: true`, the
compiler in vitest.config, `scenery.test.ts` as the teaching test, CLAUDE.md's "declaring IS
exposing" ground rule — all guarded by the template e2e. Gallery: morphogen's eight params,
aztec's four knobs, and seismos's `mc` are controls (seismos's declared INSIDE its durable
factory with an explicit name — the pattern for island-scoped controls); jump-regime/reseed/
analyze/regrow/play/pause/seek are `action()`s; get-params/set-params/set-speed/set-size/
toggle-circle/set-mc deleted outright. seismos's `set-filter`/`query` stay hand-written tools
deliberately (rich-args SQL/Selection shapes — the genuinely-bespoke case).

**Porcelain extracted (evidence: morphogen and aztec had each hand-rolled an identical local
`Slider`, morphogen a third inline `knob()`, plus the template's inline pair — bounds duplicated
at every call site):** `ControlSlider` + `ControlToggle` on the core barrel. Meta-driven
(min/max/step/unit from the control — one source of truth with the agent's `set`), writes through
the control's validation, `data-control` + description-as-title attribution stamps, the existing
CSS-class contract (`slider`/`slider-label`/`check`), a `class` prop for layout variants, `format`
for readouts. NOT extracted: aztec's scrub slider (playhead + pause side effect — not
control-shaped; bespoke is correct).

**Testing-semantics fix the template e2e caught:** `resetControlSurface()` now restores declared
initial values + clears edges while KEEPING registrations — module-declared controls don't
re-import between tests, so unregistering left every test after the first with an empty registry.
The hard clear (`clearControlSurface`) remains library-internal. `ControlBox` gained
`readonly initial` (also a reset-button affordance).

### Porcelain possibility list (unforced; extract only on repeat evidence)

- **Slider with a tiny preview visualization** — Nehal's stated want: a micro-viz in the label
  showing what the value does, possibly live on the UNCOMMITTED drag value (commit-on-release
  policy in meta). Needs a real page wanting it first (walkthrough diffusion κ is a candidate).
- **`ControlSelect`** — enum controls (`options` meta) as a `<select>`. One real use so far
  (morphogen reseed *kind* is action-args, not a control) — wait for a second.
- **Adjustable-plot macro** — a Plot figure + the controls that shape it as one composed block
  (the "hero + deep-dive reuse" pattern). Extract from the walkthrough if it repeats.
- **Adapter control** — `control()` over external get/set (Mosaic Selection ranges) so
  crossfilter state joins the surface/report. seismos's set-filter is the motivating case.
- **Play/pause transport** — aztec's play/pause/seek trio (boolean control + actions + scrub) is
  a recognizable "player" macro; one instance so far.
- **Reset affordance** — a per-control or per-panel "back to initial" button riding
  `ControlBox.initial`.
- **`data-control` in the locator/report views** — shot locator and `locate` could surface
  control stamps like cell stamps (attribution symmetry, phase 5-ish; noted in attribution.md
  debts).


## Phase 4 + Phase 5 complete (2026-07-10) — plan fully executed

**Phase 4** shipped as `demos/walkthrough`: the playbook executed in order on 1-D diffusion,
every layer left standing as its own page (multi-entry Vite: `step1`/`step2`/`step3`/index),
`WALKTHROUGH.md` narrating each diff, 11 tests including a stub-worker headless graph suite.

**Phase 5 (docs + skill)** — every debt in the notes above is paid:

- **User guide**: new Step 2 (the control surface) with all later steps renumbered; Step 13
  rewritten around the derived tools ("don't write tools — declare controls and actions");
  testing step gains the three rules (cells inside the harness, `resetControlSurface` in
  afterEach, compiler under Vitest); gotchas gain rename-resets-state and never-re-type-bounds;
  walkthrough added to where-to-go.
- **Playbook**: layer 2 opens with the surface declaration; DoD extended (described+constrained
  controls, set→observe round-trip, edges in report); layer 3 mentions the widgets; walkthrough
  is THE worked example.
- **Design choices**: §2 identity covers control/action + build-and-serve injection (compiler is
  load-bearing); §6 replaced the "ergonomic direction" future-tense paragraph with the shipped
  control surface.
- **Attribution**: `data-control` row in the contract table; report(full) as the resolution
  surface; the one manual attribute rule now names both `data-cell` and `data-control`.
- **Hard-won**: biome eats trailing `export {}`+attached comment; compiler-under-Vitest; babel
  non-ASCII escapes; new "Testing cells and controls headless" section (NO_OWNER_BOUNDARY,
  stub-worker seam, reset semantics).
- **aiui-viz README**: control/action/registerStandardTools/widgets/testing rows updated.
- **Skill** (`frontend-design`): declaring-is-exposing replaces the tool-twin rule; layer 2 =
  controls + cells; DoD includes the surface; walkthrough referenced.
- **new-demo `claudeMd()`** synced with the template's Phase-3 ground rules; root CLAUDE.md
  names the walkthrough as the teaching demo.

Gates at completion: lint, `pnpm -r typecheck`, 1539 tests / 146 files, template e2e,
docs:build, skills:check — all green. Remaining open threads: the porcelain possibility list
above (extract on evidence) and multi-client (§4, deferred by decision).


### SPA-shell candidates (2026-07-10, from the gallery rewrite)

The gallery's SPA conversion (spa-navigation-and-turn-continuity.md) left three page-navigation
patterns in app code, one consumer each — possibility-list material, not extractions:

- **The route shell**: TABS-driven pushState router + lazy page modules + per-page
  activate/deactivate lifecycle + title/theme ownership (`demos/gallery/src/site/router.ts` +
  `pages.ts` + the `Shell` in `main.tsx`, ~150 lines total). Extract when the starter template
  grows its "add a page" recipe — that's the second consumer.
- **`interceptLocalLinks`**: delegated same-origin anchor interception, the piece that makes
  routed navigation the default idiom rather than a discipline. Framework-free already.
- **Registry scoping**: under one document every page's controls/cells/edges merge into the
  global reflection registries (each kit's `report` sees all pages). Uniqueness-of-names is the
  working rule; a first-class `scope` on the registry (and per-kit filtered reports) waits for
  evidence that an agent actually gets confused. **Update (2026-07-10): shipped** — `scope()` in
  aiui-viz qualifies controls/actions/cells/durables per instance (`left/freq`), motivated by the
  slice-reuse work rather than page separation; `packages/aiui-oscillator` + `demos/twins` are
  the worked example, and the compiler now injects identity across workspace boundaries
  (dotdot-relative locs) and in library builds (`locPrefix`). Per-kit filtered reports remain
  unbuilt (the report shows the whole qualified surface).
