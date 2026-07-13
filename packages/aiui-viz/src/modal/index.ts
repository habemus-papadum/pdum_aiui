/**
 * `@habemus-papadum/aiui-viz/modal` — the modal interaction kit.
 *
 * The distilled shape of the dev overlay's modal system (armed modes, layered
 * keymaps, mode-dependent surfaces, guarded async effects), extracted per
 * `handoff/modal-interaction-lessons.md` so viz apps get the bug classes
 * designed out instead of re-learned: modes as data with a mechanical Esc
 * ladder, keymap layers whose claim-or-pass is exhaustive by construction, a
 * reconciler that asserts surface invariants from state on every event,
 * effects that re-validate at completion time under a ceiling, focus as
 * tracked state, and the shared word-diff flash (one visual language, one
 * tempo, for "this text changed in front of you").
 *
 * The kit's *modules* do NOT own state — but the kit now also ships the
 * composition layer both intent clients used to hand-roll: the **mode
 * engine** (engine.ts — regions + a pure command reducer + mechanical
 * esc/blur + atomic commit), **claims** (claims.ts — derived async
 * operations with per-claim status; the end of hand-called `sync*`
 * functions), and the **bar projection** (bar.ts — caps as renders of the
 * spec). Apps that want the engine give it their state wholesale; apps with
 * their own architecture keep using the modules à la carte. Design doc:
 * docs/proposals/intent-client/01-mode-engine.md. The Solid adapter
 * (`solidModeEngine`) lives in the package root, keeping this subpath
 * framework-free.
 *
 * Realm rules: no Solid import, no DOM access at module scope (DOM only
 * inside install/render functions), so this subpath is safe to import from
 * node (the channel reaches `wordDiff` through the overlay's intent
 * pipeline) and from workers.
 */

export {
  type BarInputs,
  type BarItem,
  type BarNode,
  type BarRow,
  barModel,
  type CapSpec,
  type CapView,
  type WidgetSpec,
  type WidgetView,
} from "./bar";
export {
  type ClaimPhase,
  type ClaimSpec,
  type ClaimSpecs,
  type ClaimStatus,
  type ClaimsHandle,
  type ClaimsOptions,
  createClaims,
} from "./claims";
export { type DiffRun, wordDiff } from "./diff";
export { type GuardedOutcome, type GuardOptions, guardedEffect } from "./effect";
export {
  type ChoiceRegion,
  type CommandFn,
  choice,
  createModeEngine,
  type DispatchEvent,
  type EngineEvent,
  type EngineState,
  type EventBinding,
  type ExcludeRule,
  type LadderRegion,
  ladder,
  type ModeEngine,
  type ModeEngineOptions,
  type ModeEngineSpec,
  type RegionSpec,
  type RegionValue,
  type StatePatch,
  type ToggleRegion,
  toggle,
} from "./engine";
export {
  DEFAULT_DIFF_CLASSES,
  type DiffRunClasses,
  isExtension,
  LIVE_FLASH_MS,
  LiveDiffText,
  type LiveDiffTextOptions,
  renderRuns,
  runsFragment,
  SETTLE_FLASH_MS,
} from "./flash";
export { createFocusTracker, type FocusTracker } from "./focus";
export {
  type InstallKeysOptions,
  installKeys,
  isTypingTarget,
  type KeyBinding,
  type KeyClaim,
  type KeyHint,
  type KeyLayer,
  keyHints,
  resolveKey,
} from "./keys";
export { blurExitTarget, escTarget, type ModeSpec, type ModeTable, runTransition } from "./mode";
export { createReconciler, type ReconcilerOptions, type SurfaceRule } from "./reconcile";
