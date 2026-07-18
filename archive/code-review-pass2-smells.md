# Code review, pass 2 — the code-smell sweep

**Status: EXECUTED in full, 2026-07-18.** The direct fixes landed as four commits
(S9 `cefb0c2`, S8 `4dfbbe8`, S6 `58808a8`, S7 `504987a`), and after wholesale approval
of the five decision documents the catalog dimensions landed as five stage commits —
S4 `84ddd7d` (surface pruning + the channel /internal seam), S1 `cf2072f` (mirror
collapses + drift guards), S5 `517d15c` (PageCapabilityMap + the trace-stage label
contract), S2 `74bebaa` (aiui-room-relay + session-core + lifecycle/common.mjs),
S3 `095f525` (all nine module splits) — every stage gated on the full workspace
suite (typecheck, tests, biome, test:packaging, version:check). Outstanding
side-flags: `pnpm npm:reserve aiui-room-relay` + `npm:trust` before the next release;
a live `aiui claude` verify of runMcp is belt-and-braces; hot-reload depth for
intent-v1's new wing modules now requires a channel restart. The decision documents
below record what was approved:

- [S1 — mirror & twin contracts](./code-review-pass2-s1-mirrors.md)
- [S2 — copy-descended subsystems](./code-review-pass2-s2-subsystems.md)
- [S3 — oversized-module split plans](./code-review-pass2-s3-splits.md)
- [S4 — published-API surface pruning](./code-review-pass2-s4-api.md)
- [S5 — stringly-typed wire dispatch](./code-review-pass2-s5-dispatch.md)

S10 (comment-style policy) was adopted, sharpened per the markup: even one-sentence
history must be very selective — most war stories just go; the written rule lands in
CLAUDE.md with the docs pass. Original proposal text follows unchanged.

- **Date:** 2026-07-18
- **Scope:** the 16 tracked packages + demos + `scripts/`. Source only — the docs/skills pass
  stays separate and last, as planned.
- **Ground rule for every dimension:** behavior-preserving. This pass reshapes code — dedupes,
  splits, types, derives — it does not change what anything does. Every change rides with the
  affected packages' tests, `pnpm -r typecheck`, and `pnpm test:packaging` when a package.json
  or barrel is touched.

**How to respond** — under each dimension:

```
- [ ] Catalog it (include in the agent run)
- [ ] Fix directly (skip the catalog, work it serially)
- [ ] Defer
- [ ] Drop (accepted as-is)

Comments:
```

Each dimension below states a recommendation; the split matters because the catalog run costs
real tokens and only pays where the instance inventory is genuinely unknown or the fix needs a
design derived from the full inventory.

---

## The dimensions

### S1. Comment-enforced twins & mirror-not-import contracts

The workspace deliberately restates shapes and logic across package/process boundaries
instead of importing them, held in sync only by "change both together" comments and (in the
best cases) cross-check tests:

- Wire shapes: `aiui-intent-runtime/protocol.ts`'s `ChunkDescriptor` and `ChannelErrorMessage`
  mirror the channel's `frame.ts`/`channel.ts`; the runtime's `TabInfo`/`PageTabRecord` mirror
  the channel and lowering types; `aiui-remote-bar/protocol.ts`'s `WireCap` restates
  aiui-viz's `CapView`; `aiui-vscode` hand-mirrors the registry entry, session-hub peer, and
  `claude agents --json` contracts; the intent client's session.ts restates the vscode
  contribution contract.
- Logic/constant twins: `page/driver-watch.ts` has an inline twin (with hand-copied
  `DRIVER_TIMEOUT_MS`) in the injected CDP bootstrap; the extension content script and the CDP
  page-script are deliberate near-twins (ring/flash/region visuals, the capability set);
  capability inventories are re-narrated in prose in at least three places that disagree.

Some of these are *load-bearing decisions* (the CDP bootstrap is stringified and may import
nothing; dependency-direction rules forbid some imports), so the work is NOT "import
everything": it is a catalog that classifies each mirror as (a) importable now, (b) genuinely
constrained — then give it a drift-guard test, or (c) collapsible by moving the contract to a
shared home. That classification needs the full inventory and per-site constraint analysis.

**Recommendation: catalog it.**

- [ X] Catalog it (include in the agent run)
- [ ] Fix directly
- [ ] Defer
- [ ] Drop

Comments:

### S2. Copy-descended subsystems

Whole modules cloned and diverging:

- `aiui-pencil` and `aiui-remote-bar` each carry a near-twin room-relay backend + sidecar
  (register/join/leave/sessions, WeakMap heartbeat, `sendJson`/`parseRequestUrl`,
  handleHttp/handleUpgrade seams) — a shared relay core is the obvious candidate, with each
  package keeping only its message vocabulary.
- The channel's voice-vendor sessions (`realtime.ts`, `openai-live.ts`, `gemini-live.ts`,
  `elevenlabs-realtime.ts`) re-implement the per-segment binding/commit/drain/outbox state
  machine 3-4×, re-declare `concatChunks`/`toBase64`/`fromBase64` per module, and copy the
  same `FakeUpstream` scripted-socket fixture into four test files.
- `commands/mcp.ts` vs `commands/serve.ts` (channel) duplicate lifecycle blocks: registry
  registration + exit backstop, the `AIUI_CHANNEL_WATCH` staleness watch, shutdown sequencing.
- `scripts/new-package.mjs` vs `scripts/new-demo.ts` re-implement slugify/fail/parseArgs/
  deriveContext/currentVersion in two dialects.

The consolidation *design* (what the shared core's seam looks like, especially for the relay
twins and the vendor sessions) is the hard part and should be derived from a precise diff of
the twins — agent work.

**Recommendation: catalog it** (same run as S1 — the finders overlap heavily).

- [ X] Catalog it (include in the agent run)
- [ ] Fix directly
- [ ] Defer
- [ ] Drop

Comments:

### S3. Oversized multi-concern modules

Current counts (tracked source):

| file | lines | concerns packed in |
| --- | --- | --- |
| `aiui-claude-channel/src/intent-v1.ts` | 1,427 | hello resolution/coercions · vendor seam wiring · speculative-compose cache · linter sidecar wiring · segment commit floors · fin commit (one ~1,000-line function) |
| `aiui-pencil/src/surface.ts` | 1,279 | tile store · fade/warp animation · resize policies · remote-pen entry points · capture keep-warm · DOM adoption |
| `aiui-lowering-pipeline/src/engine.ts` | 1,236 | state machine · five-pass compiler · latency-estimation heuristics |
| `aiui-intent-client/src/cdp/cdp-bus.ts` | 748 | attach/park/replay · transport · targeting · capture · heartbeat |
| `aiui-intent-client/src/cdp/page-script.ts` | 683 | one giant injectable function |
| `aiui-intent-client/src/lanes.ts` | 668 | wire lanes · claims · talk composition |
| `aiui-intent-client/src/ui/turn-preview.tsx` | 653 | peek engine · heat rows · five chip renderers · editor door |
| `aiui-claude-channel/src/web.ts` | 609 | `startWebServer` alone is ~400 lines: routes, three ws endpoints, reload orchestration, sidecar lifecycle |
| `aiui-intent-client/src/ui/panel.tsx` | 553 | stylesheet · pills model · layout |

Splitting these is high-value but the riskiest dimension (`intent-v1.ts` and `engine.ts` are
the system's core), and each file needs its own seam plan — where the natural module
boundaries are, which internals become exports, what the tests pin. A per-file split
*proposal* from agents (no edits), reviewed before any file is touched, is the safe shape.

**Recommendation: catalog it** — as per-file split plans, executed one file per sitting,
never in bulk.

- [ X] Catalog it (include in the agent run)
- [ ] Fix directly
- [ ] Defer
- [ ] Drop

Comments:

### S4. Published-API surface pruning

The barrels export far more than the contracts consumers use — the channel's `index.ts` alone
re-exports ~250 symbols including internal seams and test doubles (`mockSpeaker`,
`registryFileFor`, `loadModuleFresh`), and every package's public surface has accreted rather
than been decided. There is no distinction between "public contract" and "internal seam a
sibling package reaches through."

The work: per package, classify every export as contract / workspace-internal / dead, then
prune to a deliberate surface (possibly with `/internal` subpaths for the workspace-only
seams). Needs a consumer analysis per export across the workspace — mechanical but large:
agent territory. Interacts with packaging (`publishConfig` exports, `pnpm test:packaging`).

**Recommendation: catalog it.**

- [ X] Catalog it (include in the agent run)
- [ ] Fix directly
- [ ] Defer
- [ ] Drop

Comments:

### S5. Stringly-typed wire dispatch

Capability/op/stage names are literal strings matched in parallel switch ladders on both
sides of each wire, with `payload as {...}` casts at every handler:

- The page capability relay: `ext/content.ts`'s `serveRelay` handlers and the CDP
  page-script's op dispatch cast every payload by hand; the `pencil` capability's `{op, …}`
  sub-protocol is dispatched stringly on both ends.
- The trace debugger couples to the channel through bare stage-label strings, matched twice
  (a ~270-line classifier in `trace-cards.ts`, re-switched in `trace-view.ts`'s renderer).

The fix shape is known (a typed payload map per capability/op, discriminated unions for stage
labels), but the instance inventory — every capability, op, and label, on both sides —
determines how big the typed contract needs to be.

**Recommendation: catalog it** (cheap catalog, mostly mechanical fix afterwards).

- [ X] Catalog it (include in the agent run)
- [ ] Fix directly
- [ ] Defer
- [ ] Drop

Comments:

### S6. Prose inventories that should be derived

Hand-maintained lists that the code contradicts or will contradict at the next change:
`scripts/versioning.mjs`'s `MANIFEST_FILES`, `scripts/docs-gen.mjs`'s hardcoded guide
sidebar, `scripts/packaging-test.mjs`'s inline sidecar probe list, and the scaffold doc-prose
duplicated as string literals in `scripts/new-demo.ts` vs the template's own files. Known
sites, bounded fixes (derive from globs/manifests, or single-source the strings).

**Recommendation: fix directly** — no catalog needed.

- [ ] Catalog it
- [ X] Fix directly (recommended)
- [ ] Defer
- [ ] Drop

Comments:

### S7. Config/boilerplate incantations

The same load-bearing config blocks re-implemented per consumer with pointer comments:

- The externalize-builtins-plus-deps Vite lib config, duplicated across library packages,
  `scripts/_skeleton/`, and `packages/create-aiui/` (and propagated into every scaffold).
- The solid-js inline/never-external/conditions Vitest incantation, canonical in
  `aiui-viz/vite.config.ts`, re-implemented in every Solid-testing consumer.
- The identical HMR invalidate-on-accept block + explanatory comment pasted per mount-once
  module in the runtime.

Fix shape: a tiny shared config helper package (or exports from aiui-util / the skeleton) that
each consumer calls — bounded, known sites, but touches every package's build config, so it
rides with `pnpm test:packaging` and a full test run.

**Recommendation: fix directly** — no catalog needed, but land it as its own commit.

- [  Catalog it
- [ X] Fix directly (recommended)
- [ ] Defer
- [ ] Drop

Comments:

### S8. Trusted-LAN origin correctness in the debug surfaces

The trace debugger and console build `http://127.0.0.1:<port>` URLs from a bare port
(`trace-ui/src/debug-page.ts`, `traces-pane.ts` baseUrl injection, `console/app/main.tsx`),
which breaks every cross-machine viewer under the `channel.bind: host` posture — the whole
point of binding the LAN. Related trace-ui hygiene in the same files: the stylesheet lags the
DOM (dropdown classes styled nowhere, retired-picker rules remaining, one class defined twice
with conflicting box models).

Three files, clear fix (derive the origin from `location` when same-origin-served, keep the
port-only form for loopback tools).

**Recommendation: fix directly.**

- [ ] Catalog it
- [ X] Fix directly (recommended)
- [ ] Defer
- [ ] Drop

Comments:

### S9. Test-infrastructure gaps

- `aiui-claude-channel/tsconfig.json` excludes `src/**/*.test.ts` from typecheck, so test
  fixtures drift against interfaces silently — this bit twice in the last week alone (stubs
  implementing deleted interface members; a missing type import that vitest happily ran).
  Fix: a `tsconfig.test.json` (or include tests + `types: ["vitest"]`) wired into the
  package's `typecheck` script; then fix whatever it flags.
- Import-order-coupled test setup in aiui-viz (the Worker stub must be the first import or
  duckdb-wasm throws), enforced only by comment — move to a vitest `setupFiles`.
- `ext/capture.ts` holds the tabCapture stream in module-level mutable globals, making the
  MV3 capture host single-stream by construction and untestable beyond its one pure export.

First two are direct fixes. The capture.ts restructure is really an S3-style split — fold it
into S3's catalog if S3 is approved.

**Recommendation: fix directly** (capture.ts deferred to S3).

- [ ] Catalog it
- [ X] Fix directly (recommended)
- [ ] Defer
- [ ] Drop

Comments:

### S10. Comment style policy (prevention, not cleanup)

The codebase documents itself in essay-style headers that narrate design history, dated
reworks, and war stories. The *stale* ones are gone; the question is the standing style,
which regenerates staleness at every pivot: provenance prose rots the moment its referent
moves. A short written rule (e.g.: comments state the current contract and the load-bearing
why; history beyond one sentence lives in `docs/proposals/`/`archive/`, linked not narrated;
no dates/plan-codes in code comments) — added to CLAUDE.md in the docs pass — would cap the
regrowth. No sweep: existing comments stay until touched.

**Recommendation: adopt the policy** (a decision, not a work item; text lands with the docs
pass).

- [X ] Adopt the policy
- [ ] Different policy (see comments)
- [ ] Drop

Comments:
Agreed -- making long essays with proper nouns is going to be impossible to maintain. Even the one sentence history should be very, very selective. About which ones we want and which ones we can just forget about.  at This point is not a good idea: to keep every single war story. 
---

## The plan, once this is marked up

1. **Direct-fix dimensions** (recommended: S6, S7, S8, S9) — serial implementation, one
   commit per dimension, full gates each.
2. **Catalog run** for the approved catalog dimensions (recommended: S1, S2, S3, S4, S5) —
   one team-of-agents pass, structured like the last one: per-area finders enumerating every
   instance with file:line and per-site constraints, adversarial verifiers checking each
   claimed duplicate/dead export/split seam against the tree, results synthesized into
   **pass-2 decision documents** (one per dimension, with the same response blocks). Scale
   estimate: comparable to the previous review run (~25-30 agents, ~3M tokens, ~20 minutes).
3. **Implementation** of the catalog dimensions after markup — S5 and S4 are mostly
   mechanical once decided; S1/S2 land consolidation-by-consolidation; S3 lands one file per
   sitting.

Standing risk controls: behavior-preserving only; every step gated on the affected packages'
tests + workspace typecheck; `pnpm test:packaging` whenever exports/package.json change; no
`.md`/skill edits (docs pass remains last).

- [ ] Plan approved as scoped
- [ ] Adjust (see comments)

Comments:
