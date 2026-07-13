# Handoff: guidance for the next agent (2026-07-13)

Written at the end of the investigation session that produced this folder and
[the write-semantics proposal](../solid-write-semantics-and-the-imperative-boundary.md), for an
agent starting with fresh context. Read those five documents first; this file adds what came
*after* them: the owner's follow-up question (are these actually Solid apps?), an assessment of
the **greenfield-parallel** strategy the owner is now considering, and the salvage/do-not-copy
lists a rebuild needs. [04-parity-inventory.md](./04-parity-inventory.md) preserves the full
mode inventory — it is the parity checklist; it exists nowhere else.

## 1 · "Are the extension and overlay proper SolidJS apps?" — No. Measured:

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

## 2 · The greenfield-parallel strategy: assessed, recommended with adjustments

The owner is considering: build a **new extension + testing harness from scratch**; leave the
web overlay and current extension untouched as working **safety nets** (not architectural
references). Assessment: **sound, and in one respect better than the in-place plan in
[README.md](./README.md)** — with the adjustments below. (It amends the README's Phases 1–3;
Phase 0 hygiene and the Phase-2 mode engine are unchanged. Confirm direction with the owner
before retiring anything.)

**Why it's sound here.** The rewrite surface is small: every lane is an imported package the
new app imports identically; what must be written new is the conductor (~1.5 k lines being
replaced by the mode engine anyway), the MV3 glue (`sw.ts` 141 lines, `content.ts` 340 — mostly
hosting shared modules), and the manifest. The audit's hardest sequencing problem —
"characterize the old brain first, or extract the machine first? the transport interface will
re-tangle if you refactor in place" — simply dissolves: greenfield is spec-first (the §13.6
tables + [04](./04-parity-inventory.md) + the bug ledger *are* the spec), and nothing
destabilizes the daily driver while it's built.

**The one big adjustment — invert the build order.** Do not start with a Chrome extension.
Build the new client as **the detached plain page first** (03 §4): channel-served panel, mode
engine, lanes, `FakeBus`/`CdpBus` transports — agent-drivable and HMR-native from the first
commit. Add the MV3 shell **last**, as just another transport + a packaging step
(`ExtensionBus`, the 141-line SW broker, a static Vite build — **no CRXJS in the new app,
ever**; F3 then never exists). The extension stops being the app's home and becomes one way to
ship it. This is the deepest payoff of greenfield: the current architecture *cannot* be built
in that order; a new one can.

**Second-system guardrails.** The rebuild is bounded by data that already exists: parity =
[04-parity-inventory.md](./04-parity-inventory.md) row by row; semantics = §13.6 + its
divergence ledger (overlay stays the reference for *semantics* even while its *code* is only a
safety net — write the overlay's spec descriptively for the diff test without porting it);
regressions = the ~25-incident bug ledger as acceptance tests. If the new spec grows escape
hatches the model in [01](./01-mode-engine.md) can't express, stop and revisit 01 rather than
improvising.

**Sequencing (amended).**
0. Phase 0 hygiene, unchanged — library-level, benefits old and new alike. Include re-landing
   the Solid semantics-pin test (the probe content is fully specified in the write-semantics
   proposal §8; the scratchpad copy died with the session).
1. Mode-engine kernel in `aiui-viz/modal`, spec-first tests (§13.6 tables, esc/blur properties,
   claims tables).
2. New package (see naming below): plain-page panel on the engine + lanes + `FakeBus`; every
   behavior lands with a harness test; daily dev entirely in the harness.
3. `CdpBus` against the session browser (plumbing exists: `installCaptureMarker` pattern,
   `browser.ts` discovery); now it drives real tabs.
4. MV3 shell: `ExtensionBus`, SW broker (copy it — see salvage), content glue, static build,
   `aiui extension dev/reload` re-point for release verification only.
5. Parity gate against [04](./04-parity-inventory.md); the old extension then goes into
   safety-net retirement (loaded, untouched, available) until confidence; the overlay stays
   as-is throughout.

## 3 · Ground rules for the new code (the lessons, as imperatives)

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

## 4 · Salvage list — carry the scars, not the scaffolding

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

## 5 · Do-not-copy list

`main.tsx`'s architecture (the machine, the five `sync*`, the island `queueMicrotask` dance,
the 20 inline `chrome.*` sites); `liveSignal` and all control-mirrors (the `videoOnLive`
double-write is a live agent-facing bug — write-semantics §4.2); the phase/engine dual-truth
(`engine.setArmed` beside `phase` writes); `modality.ts` as code (its *semantics* are the
reference; its 1,597-line shape is the anti-pattern); CRXJS and the entire dev-artifact
machinery (dist-dev split, stamps — superb work that the new architecture makes unnecessary);
the imperative class-island pattern for new UI.

## 6 · Coexistence mechanics (running old + new side by side)

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

## 7 · Practical notes for a fresh context

- House rules that bite: run `pnpm lint` before finishing (pre-commit enforces); `pnpm -r
  typecheck` includes demos; `pnpm test:packaging` whenever packaging fields change; new
  packages via `pnpm new-package <name> --public|--private|--no-publish` (no default); never
  hand-edit versions; direct commits to main, no PRs; model-facing prompts are published
  verbatim in docs; mock backends never ship as defaults.
- The `frontend-design` skill and `docs/guide/frontend-*.md` still teach the *old* scoping of
  the write-batching rule — Phase 0 includes fixing them (write-semantics M8). Until then,
  distrust "where it bites: tools and tests."
- `solid-js@2.0.0-beta.15` facts you will need constantly: `flush()` is exported (dev *and*
  prod) and runs effects synchronously; setters return the written value; owned-scope writes
  throw in dev only; `{ ownedWrite: true }` opts a signal out; memos over fresh writes are
  stale until commit; `createStore` defers identically.
- The three audit reports behind these documents lived in the investigating session only;
  everything load-bearing was folded into 01–04. If a claim needs re-verification, the file:line
  cites were all checked against `bbd9fff`/`8b43d16` (2026-07-13).
