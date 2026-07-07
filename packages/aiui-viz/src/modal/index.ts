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
 * The kit does NOT own state. Apps keep their own architecture (for the
 * overlay: an append-only event stream and pure folds — state = fold(events),
 * UI = projection); the kit disciplines the SHELL around it — modes, keys,
 * surfaces, effects — which is where all fifteen of the overlay's real bugs
 * lived.
 *
 * Realm rules: no Solid import, no DOM access at module scope (DOM only
 * inside install/render functions), so this subpath is safe to import from
 * node (the channel reaches `wordDiff` through the overlay's intent
 * pipeline) and from workers.
 */

export { type DiffRun, wordDiff } from "./diff";
export { type GuardedOutcome, type GuardOptions, guardedEffect } from "./effect";
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
  type KeyLayer,
  resolveKey,
} from "./keys";
export { escTarget, type ModeSpec, type ModeTable, runTransition } from "./mode";
export { createReconciler, type ReconcilerOptions, type SurfaceRule } from "./reconcile";
