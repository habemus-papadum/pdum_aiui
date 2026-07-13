# The intent client: one core, a mode engine, and a greenfield detached panel

**The question** (2026-07-13): the Chrome extension is hard to use and hard to debug — Solid
write-semantics bugs and CRXJS dev-loop failures compound; the panel seems to reinvent what the
overlay already has; the viz modal kit may be insufficient for our real mode structure. *Are we
in a pretty good place, or is the code structurally unsound? How expansive should the fix be —
mode-engine deep dive, a CDP-based parallel dev workflow, a component re-architecture?*

This folder is the answer, compiled from three code audits (reuse/decomposition, a full mode
inventory, dev-loop/host capabilities) plus the
[write-semantics investigation](../solid-write-semantics-and-the-imperative-boundary.md):

- **[01 · The mode engine](./01-mode-engine.md)** — the modeling exercise: what our modes
  actually are, why the kit can't hold them, the engine spec that can.
- **[02 · Components and reuse](./02-components-and-reuse.md)** — what's shared, what got
  reinvented and why, host-coupling numbers, the target component map.
- **[03 · Hosts and the dev loop](./03-hosts-and-dev-loop.md)** — the four host architectures,
  the residual dev pain, and the detached-harness design.
- **[04 · Parity inventory](./04-parity-inventory.md)** — every mode, claim, and mode-bug in
  both clients; the greenfield parity checklist. **It exists nowhere else — it is the spec.**

This README is the plan of record. An earlier revision proposed an *in-place* refactor
(characterize the old panel, then port it region-by-region); a follow-up handoff assessed the
owner's **greenfield-parallel** alternative and recommended it. The two are merged here — the
greenfield sequencing below supersedes the in-place Phases 1–3, and §"Why greenfield" records
what the in-place plan got right and why it lost.

## Verdict

**The code is not structurally unsound — but one structure was never built, and everything
painful traces back to it.**

The healthy part is large: every lane (engine, wire, talk, video sampler, ink, paint, preview,
trace, relay, ring) is shared between the overlay and the extension with **zero forks**, and the
overlay's 645 tests never broke during panel development. Two subsystems (`panel/capture.ts`,
`paint.ts`) already do host-effect injection perfectly. The wire never even needed the
extension — the panel talks to the channel over plain loopback WebSocket.

The sick part is precise:

1. **The conductor was duplicated instead of shared — against the plan's own instruction.**
   §13.6 Phase C said to mount the overlay's `modality.ts` in the panel *"ported, not
   reimplemented."* That never happened; the panel re-grew a parallel orchestrator. Result: two
   ~1,500-line hand-rolled conductors, and the panel's copy skipped the two mechanisms that keep
   the overlay stable (the derived `UiMode`, the per-event reconciler). The ~25-incident bug
   ledger lives almost entirely in that gap.
2. **The modal kit is vocabulary without grammar.** Its best modules are half-adopted
   (`runTransition` and `guardedEffect`: zero consumers; the reconciler: overlay only), because
   composing them is manual. It models one stored mode; our apps have ~46 modes across
   orthogonal regions, derived projections, and async per-tab claims.
3. **The panel is unverifiable by an agent.** Extension pages never commit in CDP tabs, the
   side panel opens only on user gesture, the MCP can't reach the SW. That is why every F1 bug
   was "found live by the user" — the platform structurally excludes the agent from the
   verify step.
4. **Neither client is a Solid app** (measured — see §"Are these Solid apps?" below). The
   surfaces are imperative classes driven by hand-called `sync*` functions; that single
   constraint generated both recorded bug families.

So: **not a repair of the old clients. A small, bounded rebuild of the one layer that was never
right — on top of the large shared surface that is.**

## The strategy: greenfield-parallel

Build a **new intent client and its testing harness from scratch**; leave the web overlay and
the current extension untouched as working **safety nets** (not architectural references).

**Why it's sound here.** The rewrite surface is small: every lane is an imported package the
new app imports identically; what must be written new is the conductor (~1.5 k lines being
replaced by the mode engine anyway), the MV3 glue (`sw.ts` 141 lines, `content.ts` 340 — mostly
hosting shared modules), and the manifest. Nothing destabilizes the daily driver while it's
built.

**The build order is inverted — the extension comes last.** Do not start with a Chrome
extension. Build the new client as **the detached plain page first**
([03 §4](./03-hosts-and-dev-loop.md)): channel-served panel, mode engine, lanes,
`FakeBus`/`CdpBus` transports — agent-drivable and HMR-native from the first commit. Add the
MV3 shell **last**, as just another transport + a packaging step (`ExtensionBus`, the 141-line
SW broker, a static Vite build — **no CRXJS in the new app, ever**; the F3 dev-loop failure
family then never exists). The extension stops being the app's home and becomes one way to ship
it. This is the deepest payoff of greenfield: the current architecture *cannot* be built in
that order; a new one can.

**Second-system guardrails.** The rebuild is bounded by data that already exists: parity =
[04-parity-inventory.md](./04-parity-inventory.md) row by row; semantics = §13.6 + its
divergence ledger (the overlay stays the reference for *semantics* even while its *code* is
only a safety net); regressions = the ~25-incident bug ledger as acceptance tests. If the new
spec grows escape hatches the model in [01](./01-mode-engine.md) can't express, stop and
revisit 01 rather than improvising.

### Why greenfield beat the in-place plan

The in-place plan's hardest problem was sequencing: *characterize the old brain first, or
extract the machine first? The transport interface will re-tangle if you refactor in place*
([03 §4](./03-hosts-and-dev-loop.md), the audit's warning). Greenfield dissolves it: the build
is spec-first (the §13.6 tables + [04](./04-parity-inventory.md) + the bug ledger *are* the
spec), so no jsdom characterization harness for the *old* panel is needed — its behavior is
already captured as tables, and the old panel keeps running untouched while the new one grows.
What the in-place plan got right survives intact: Phase 0 hygiene and the
[01](./01-mode-engine.md) mode engine are unchanged; the detached-page architecture
([03](./03-hosts-and-dev-loop.md) option D) is promoted from "dev harness beside the product"
to "the product's home, with the extension as a shell."

## The plan

**Phase 0 — hygiene (days).** Land the write-semantics proposal's first tranche: the dev-mode
stale-read assertion in `control()`/`durableSignal`, the `control.set(updater)` fix, the
semantics-pin test (the probe content is fully specified in the write-semantics proposal §8),
the docs/skill corrections — plus the three live bugs it found (the `videoOnLive` agent-desync,
the aztec player loop, the walkthrough `kappa` updater). Library-level; benefits old and new
alike. Independent of everything below.

**Phase 1 — the mode engine (1–2 weeks).** Build the kernel in `aiui-viz/modal`
([01](./01-mode-engine.md)): regions + pure reducer + esc/blur resolution + `flush()`-committed
dispatch; claims reconciler with per-claim status over `guardedEffect`; command-bar/help/
controls projections. **Spec-first tests**: the §13.6 tables, esc/blur properties, claims
tables — no host required.

**Phase 2 — the new client as a plain page (1–2 weeks).** New package: the panel served as a
plain page (by the channel, ideally), built Solid-native on the engine + the imported lanes +
`FakeBus`. Every behavior lands with a harness test; daily dev happens entirely in the harness;
the devtools MCP can screenshot it, click its caps, and evaluate its state — the agent verifies
its own work from the first commit.

**Phase 3 — `CdpBus` (days).** ✅ **Done.** The page transport against the session browser (the
plumbing existed: the `installCaptureMarker` pattern, `browser.ts` discovery); it now drives real
tabs — ink, key routing, ring, selection, shots on live pages, extension-free.

Two things the plan did not anticipate, both structural:

- **The page cannot reach the browser, and it cannot reach us.** Chrome refuses a websocket
  upgrade to its debug port from a page (that guard is what stops the open web from driving your
  browser), so the channel bridges it at `/intent/cdp` — the one server-side piece of the tier,
  loopback-only, and now the widest thing on the channel port (see the security warning). And the
  page cannot *fetch* from the channel either: an https page blocks a module from our http origin
  as mixed content, so nothing is imported — the bootstrap arrives as a string, and the ink
  surface is bundled by the sidecar and evaluated INTO the page.
- **The document is the unit of state, not the tab.** A reload leaves the CDP session healthy and
  the client's desire unchanged, so nothing re-applies — the page just comes back bare. The bus
  therefore re-injects on navigation and replays what it had asserted (ring, keys, ink mode).

The live findings are pinned as tests, one row each, in the client's
[PARITY.md](../../../packages/aiui-intent-client/PARITY.md) ("What Phase 3 taught us").

**Phase 4 — the MV3 shell (a week).** `ExtensionBus`, the SW broker (copied — see salvage
list), content glue, a **static Vite build**, new extension identity (see coexistence). `aiui
extension dev/reload` re-points for release verification only.

**Phase 5 — parity gate.** Walk [04](./04-parity-inventory.md) row by row: every row
implemented, consciously diverged (extend the §13.6 ledger), or consciously dropped (say so).
Then the old extension goes into safety-net retirement (loaded, untouched, available) until
confidence; the overlay stays as-is throughout.

### Decision gates

- **After Phase 1:** is the panel spec + reducer genuinely smaller and clearer than the machine
  it replaces? (If the spec grows escape hatches, the model in 01 is wrong somewhere — stop and
  revisit 01 before building the client on it.)
- **After Phase 2:** do the harness tests actually reproduce the bug-ledger rows as passing
  regression tests? If a behavior can't be exercised via `dispatch()` + fakes, its design is
  wrong — fix the design, not the test.
- **After Phase 4:** the parity gate is the release gate; the §13.6 divergence ledger is
  re-expressed as a spec diff between the overlay's descriptive spec and the new client's.

## "Are the extension and overlay proper SolidJS apps?" — No. Measured:

**The overlay is a vanilla-JS app with Solid patched in as a template engine.** Of ~19,400
non-test LOC, six files import `solid-js` (~2,366 LOC, ≈12 %); fifteen files build DOM with
`document.createElement`. And the *shape* of the Solid usage is the tell: every Solid file
exports an **imperative class or handle** — `class Preview` (preview.tsx:81), `class
ConfigStrip` (config-strip.tsx:57), `class CheatSheet`/`class KeymapHelp`
(keymap-ui.tsx:131,184), `mountWidget(): WidgetHandle` (widget.tsx:242) — that privately calls
Solid's `render()` into a root it owns and captures the setters into instance fields so the
outside drives it through method calls. The comments say it outright: *"body runs synchronously
during render(), so `api` is populated before the constructor returns"* (widget.tsx:249,
config-strip.tsx:88). The conductor (`modality.ts`, 1,597 lines) is vanilla and drives these
classes imperatively. There is no reactive graph at app level — Solid renders leaves.

**The extension is one step better: a Solid shell around an imperative core.** `main.tsx` is a
real Solid render root with JSX panes (trace-pane, turn-pane, toasts, connection-chip are
ordinary components), but its heart is the imperative §13.6 machine, and its central UI
surfaces are *the overlay's imperative classes* hosted as islands and hand-synced. Two
`createEffect`s exist in the whole package.

**Was this part of the issue? Yes — it is most of the issue, and the causal chain is
documented in the code:** the surfaces are imperative classes → building/driving them from
effects throws `REACTIVE_WRITE_IN_OWNED_SCOPE` (preview-pane.tsx:8-12) → so they are built in a
`queueMicrotask` and driven by five hand-called `sync*` functions (bug family F2) → so machine
state must be readable in the tick it was written (bug family F1) → `liveSignal` and the seven
bites. Add the write-semantics finding (Solid 2.0 removed read-your-own-writes behind an
unchanged API, so 1.x-trained priors keep regenerating write-then-read code) and the two
families are fully explained. The house *does* know how to write real Solid — `aiui-viz`'s
`CellView`/`control-widgets`/`dropdown.tsx` and every demo are the proof — but neither client
was built that way. The standing intent to port the overlay to Solid ("write new overlay UI as
Solid") already recognizes this; the extension inherited the overlay's vanilla islands and paid
the compounding interest.

## Ground rules for the new code (the lessons, as imperatives)

- **Solid-native throughout**: state lives in engine regions + signals/cells; UI is components
  reading them; JSX everywhere a DOM node is born. Imperative code only at genuine boundaries
  (canvas pixels, media streams, CDP, sockets) — and behind a `createEffect(source, handler)`
  seam, never a hand-called `sync*`.
- **One writer**: every state change is a command through the engine's dispatch
  (`flush()`-committed). Keys, cap clicks, agent `control.set`, system events — same path. No
  `liveSignal`, no mirrors, no dual-writing a second store.
- **Never read back what you just wrote** — branch on the local or the setter's return; the
  reactive graph is the only reader of writes (write-semantics M0).
- **Islands only for the genuinely external**, with `{ ownedWrite: true }` signals so effects
  may drive them; per-event reconciliation (claims), never entry/exit effects.
- **Everything headless-testable before it exists in the extension** — if a behavior can't be
  exercised via `dispatch()` + fakes, its design is wrong.

## Salvage list — carry the scars, not the scaffolding

Import unchanged (packages): all lanes (`intent-pipeline`/Engine, wire, talk, video sampler,
`aiui-ink`, `aiui-paint`, preview/caps/help *for now* — replace with Solid components as the new
panel's UI lands), `aiui-viz` (cells/controls/modal kit), `aiui-webext` relay **codecs** +
indicator + dev-stamp oracle, `aiui-util` CDP toolkit.

Copy nearly verbatim (small, clean, hard-won):
- `sw.ts` — the 141-line privileged broker (tabCapture mint + invocation-gate ledger + ⌘B
  forward). Right-sized; its error-string gate (`capture.ts:19`) is *measured*, keep it.
- `panel/capture.ts` — M10 pixel path (warm stream → `drawImage`/`toBlob` → bytes to wire;
  36–48 ms measured); already takes `mintStreamId` injected.
- `boot.ts` watchdog (fail-loud-never-blank) + `bus.ts` (pure) + `channel.ts` discovery shapes.
- `leader.ts`'s *grammar rows and tests* (the bindings/hints data — regenerate the plumbing
  from the mode-engine spec).

Decided semantics that must survive (each was paid for live): ⌘B is idempotent
grant-and-open, never cancels; Esc steps out one level, never destructive beyond scope; send
keeps you armed; disarm clears ink, nothing else does except `c`; ink is page-anchored,
per-tab; standing mic/share between turns send **nothing**; unknown in-turn keys swallow +
blip; panel-document mic (M9) for grant persistence; manual shots flash, sampled frames never;
turn recovery via a completeness-stamped mirror; storage.session dies on extension reload —
plan for it.

Measured platform facts (do not re-derive): extension pages never commit in CDP-opened tabs;
side panel opens only on user gesture; MCP can't reach the SW and its attach freezes at
launch; CDP screencast can't back a `MediaStream` (rejected for video already, `shot.ts:9-14`);
`getDisplayMedia` = sharing bar + 30 fps standing decode + one grant per document; branded
Chrome ≥137 ignores `--load-extension` (CfT for dev); Vite may bind `[::1]` only; check who
owns a port before debugging "weird dev behavior" (`lsof -nP -iTCP:<port> -sTCP:LISTEN`).

## Do-not-copy list

`main.tsx`'s architecture (the machine, the five `sync*`, the island `queueMicrotask` dance,
the 20 inline `chrome.*` sites); `liveSignal` and all control-mirrors (the `videoOnLive`
double-write is a live agent-facing bug — write-semantics §4.2); the phase/engine dual-truth
(`engine.setArmed` beside `phase` writes); `modality.ts` as code (its *semantics* are the
reference; its 1,597-line shape is the anti-pattern); CRXJS and the entire dev-artifact
machinery (dist-dev split, stamps — superb work that the new architecture makes unnecessary);
the imperative class-island pattern for new UI.

## Coexistence mechanics (running old + new side by side)

- **Different extension identity**: do NOT copy the pinned `key` from
  `manifest.config.ts` (:22) — same key = same id = Chrome treats new as an update of old.
  New key, new id; the native-messaging host allowlist is per-id (and the channel-served panel
  shouldn't need native messaging at all — its origin is the channel).
- **Different dev/serve port** than the old pinned 5317 (the port-squatting trap is in
  CONTINUITY.md; the new panel's port should be the channel's, ideally).
- **Never both armed on one tab**: two content scripts injecting ink/ring into the same page
  will collide. Simplest policy: the new client refuses to arm on a tab whose ring marker says
  the old one holds it (the `aiuiRing` message/DOM marker is detectable), or the owner just
  disables one extension while driving the other. State one policy in the new README.
- **Distinct storage namespaces** (`aiui2.*` or the new id's own `chrome.storage` — they're
  already isolated per-extension; the durable-registry keys on shared *pages* are what need a
  prefix).
- The safety nets are **frozen**: no fixes land in the old extension or overlay conductor
  except data-loss-grade emergencies; their bug ledger rows become tests in the new app
  instead.

## The owner's four questions, answered directly

**"How expansive should we be?"** A bounded greenfield: roughly 4–6 weeks across Phases 0–5,
every phase shippable alone, and the old clients untouched as safety nets throughout. The
alternative — keep patching — has a measured cost: seven bites of one bug class, each "found
live by the user," with the eighth guaranteed by the priors that generate it.

**"Deep dive into the viz modal infrastructure?"** Yes — it is the highest-leverage single move,
and the modeling exercise is done ([01](./01-mode-engine.md)). The kit's vocabulary survives
intact; what's added is the composition layer both apps hand-rolled. Grow it in
`aiui-viz/modal` per the standing convention.

**"A parallel CDP workflow for hot reloading?"** Yes — and more than a workflow: the plain page
is the new client's *home*, with CDP as its dev-time page transport. The CDP plumbing already
exists in-repo, and it dissolves most CRXJS pain rather than fixing it. The CDP port stays a
development affordance — never a shipped dependency.

**"Re-architect the extension into clear components?"** Mostly already done at the lane level —
the audit's surprise is how *good* the sharing story is. The missing component is the shared
conductor (Phase 1), plus the transport seam finished properly this time (`PageBus` +
`CaptureSource`, [02 §5](./02-components-and-reuse.md)). `sw.ts` at 141 privileged lines is the
right size; copy it.

## What we deliberately do not do

- **No lane rewrites** — the lanes are healthy and the overlay's test suite proves it; the new
  client imports them unchanged.
- **No fixes to the old conductors** — they are frozen safety nets; their bug rows become tests
  in the new app instead.
- **No XState** — statechart semantics we need are small; the value is in the integrations
  (controls, claims, flush, key layers), which are bespoke either way ([01 §4](./01-mode-engine.md)).
- **No CRXJS in the new app, ever** — the MV3 shell is a static Vite build; the F3 family never
  exists.
- **No CDP product host, no embedded-panel product** — B is structurally blocked (multi-tab,
  navigation); CDP's strengths are a harness's, its costs are a product's. The detached page +
  `ExtensionBus` is the product.
- **No async-everything** — the write-semantics proposal's anti-mitigation B: the axis is
  derive-vs-read-back, not sync-vs-async.

## Practical notes for a fresh context

- House rules that bite: run `pnpm lint` before finishing (pre-commit enforces); `pnpm -r
  typecheck` includes demos; `pnpm test:packaging` whenever packaging fields change; new
  packages via `pnpm new-package <name> --public|--private|--no-publish` (no default); never
  hand-edit versions; direct commits to main, no PRs; model-facing prompts are published
  verbatim in docs; mock backends never ship as defaults.
- `solid-js@2.0.0-beta.15` facts you will need constantly: `flush()` is exported (dev *and*
  prod) and runs effects synchronously; setters return the written value; owned-scope writes
  throw in dev only; `{ ownedWrite: true }` opts a signal out; memos over fresh writes are
  stale until commit; `createStore` defers identically.
- The three audit reports behind these documents lived in the investigating session only;
  everything load-bearing was folded into 01–04. If a claim needs re-verification, the file:line
  cites were all checked against `bbd9fff`/`8b43d16` (2026-07-13).
