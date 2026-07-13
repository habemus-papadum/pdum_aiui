# The intent client: one core, a mode engine, and a detachable dev host

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

So: **not a rewrite. Three structural moves, each surgical, each independently valuable,
sequenced so each pays for the next.**

## The plan

**Phase 0 — hygiene (days).** Land the write-semantics proposal's first tranche: the dev-mode
stale-read assertion in `control()`/`durableSignal`, the `control.set(updater)` fix, the
semantics-pin test, the docs/skill corrections — plus the three live bugs it found (the
`videoOnLive` agent-desync, the aztec player loop, the walkthrough `kappa` updater). Independent
of everything below; stops the bleeding that makes later steps hard to verify.

**Phase 1 — the brain becomes testable (days).** A jsdom **characterization harness** for the
*current* panel: fake `chrome.*` global (the audit enumerated the exact 15-method surface),
real `Engine`, drive `leaderDispatch`/phase transitions, assert island DOM + ring broadcasts +
relay claims. No refactor first — this pins today's behavior. Encode the bug ledger as
regression rows (STATUS.md §4.3 already asked for exactly this). Every subsequent phase runs
under these tests.

**Phase 2 — the mode engine (1–2 weeks).** Build the kernel in `aiui-viz/modal`
([01](./01-mode-engine.md)): regions + pure reducer + esc/blur resolution + `flush()`-committed
dispatch; claims reconciler with per-claim status over `guardedEffect`; command-bar/help/
controls projections. Port the panel region-by-region under the Phase-1 harness; the five
`sync*` functions become claims; the six phase-mutation sites become one dispatch; the agent
`set` path and the `v` key become the same command. Acceptance: the §13.6 divergence ledger
re-expressed as a spec diff, and the bug-ledger rows green.

**Phase 3 — the detachable panel (a week).** With the machine out of `main.tsx`, extract the
`PageTransport`/`SurfaceTargeting` facade (the relay seam is ~80 % built), add the `CdpBus`
over the CDP plumbing the repo already ships (`installCaptureMarker` is the pattern), and add
`aiui panel harness`: the panel as a plain page — full HMR, real channel, real tab via CDP,
**drivable by the devtools MCP**. The agent can finally verify its own panel work
([03](./03-hosts-and-dev-loop.md) §4). The MV3 extension remains the production host.

**Phase 4 — consolidation, each piece now cheap, none urgent.**
- The overlay's planned Solid port adopts the engine + core: `modality.ts`'s 1,597 lines shrink
  to a spec + lane appliers, and the "embedded panel" host (option B) falls out for free.
- CRXJS: after a week of daily development that never needed `aiui extension dev`, swap the
  production build to a static Vite config and delete the dev-artifact machinery (F3 removed at
  the root). Not before.
- Optional ports the divergence ledger flags: config strip / session layering into the panel.

### Decision gates

- **After Phase 1:** do the harness rows actually reproduce the ledger bugs? If the brain can't
  be driven headlessly even with the enumerated fakes, stop and learn why before the engine.
- **After Phase 2:** is the panel spec + reducer genuinely smaller and clearer than the machine
  it replaced? (If the spec grows escape hatches, the model in 01 is wrong somewhere — revisit
  before porting the overlay.)
- **After Phase 3:** the CRXJS decision, on the daily-driver measure above.

## The owner's four questions, answered directly

**"How expansive should we be?"** Structural but surgical: roughly 3–4 weeks of focused work
across Phases 0–3, none of it a rewrite, every phase shippable alone. The alternative — keep
patching — has a measured cost: seven bites of one bug class, each "found live by the user,"
with the eighth guaranteed by the priors that generate it.

**"Deep dive into the viz modal infrastructure?"** Yes — it is the highest-leverage single move,
and the modeling exercise is done ([01](./01-mode-engine.md)). The kit's vocabulary survives
intact; what's added is the composition layer both apps hand-rolled. Grow it in
`aiui-viz/modal` per the standing convention.

**"A parallel CDP workflow for hot reloading?"** Yes as the *dev harness*, no as a product
host. The detached panel is the only architecture with no blocked capability, the CDP plumbing
already exists in-repo, and it dissolves most CRXJS pain rather than fixing it. The CDP port
stays a development affordance — never a shipped dependency.

**"Re-architect the extension into clear components?"** Mostly already done at the lane level —
the audit's surprise is how *good* the sharing story is. The missing component is the shared
conductor (Phase 2), plus finishing the transport seam that is already 80 % routed (Phase 3).
`sw.ts` at 141 privileged lines is the right size; leave it.

## What we deliberately do not do

- **No rewrite** — the lanes are healthy and the overlay's test suite proves it.
- **No XState** — statechart semantics we need are small; the value is in the integrations
  (controls, claims, flush, key layers), which are bespoke either way ([01 §4](./01-mode-engine.md)).
- **No CDP product host, no embedded-panel product now** — B is structurally blocked
  (multi-tab, navigation); C's strengths are a harness's, its costs are a product's.
- **No immediate CRXJS removal** — gate it on the harness proving itself.
- **No async-everything** — the write-semantics proposal's anti-mitigation B: the axis is
  derive-vs-read-back, not sync-vs-async.
