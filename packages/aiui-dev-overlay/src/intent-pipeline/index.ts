/**
 * The intent pipeline: the framework-free, browser-safe core of the multimodal
 * intent tool. One append-only {@link IntentEvent} stream, the little state
 * machine that produces it ({@link Engine}), the minimal keymap, the V4A
 * correction diff machinery, and the {@link composeIntent} pass that folds a
 * thread's events into the lowered Option-C body + meta.
 *
 * Prototyped in the workbench, graduated here so the overlay's modality and the
 * channel's lowering processor share one implementation (and one set of
 * captured fixtures as the regression net). Zero DOM; the only dependency is
 * the equally realm-free modal kit (`aiui-viz/modal`), which the keymap's
 * layer resolution and `wordDiff` now come from.
 *
 * @packageDocumentation
 */

export type { IntentPipelineConfig, IntentTier } from "./config";
export {
  DEFAULT_INTENT_CONFIG,
  DEFAULT_TIER,
  engineOf,
  expandTier,
  TIER_CONTROLLED_KEYS,
  TIER_PRESETS,
  TRANSCRIPTION_ENGINES,
  type TranscriptionEngine,
} from "./config";
export type {
  ComposedIntent,
  ComposedItem,
  ComposeOptions,
  EngineListener,
} from "./engine";
export {
  composeIntent,
  Engine,
  renderAppSelection,
  renderCodeSelection,
  SHORT_SELECTION_CHARS,
} from "./engine";
export type { KeyCommand, KeymapHelpSection, KeyState } from "./keymap";
export {
  ENGINE_DIGITS,
  installKeymap,
  intentKeyHints,
  isTypingTarget,
  keyCommand,
  keymapHelp,
} from "./keymap";
export type { DiffRun } from "./patch";
export { applyCorrectionToLines, applyPatch, wordDiff } from "./patch";
export type {
  AppSelection,
  CodeSelection,
  IntentEvent,
  LocatedCell,
  LocatedComponent,
  Mode,
  Rect,
  TranscriptWord,
} from "./types";
