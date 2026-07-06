/**
 * The intent pipeline: the framework-free, browser-safe core of the multimodal
 * intent tool. One append-only {@link IntentEvent} stream, the little state
 * machine that produces it ({@link Engine}), the minimal keymap, the V4A
 * correction diff machinery, and the {@link composeIntent} pass that folds a
 * thread's events into the lowered Option-C body + meta.
 *
 * Prototyped in the workbench, graduated here so the overlay's modality and the
 * channel's lowering processor share one implementation (and one set of
 * captured fixtures as the regression net). Zero DOM, zero deps.
 *
 * @packageDocumentation
 */

export type { IntentPipelineConfig, IntentTier } from "./config";
export {
  DEFAULT_INTENT_CONFIG,
  DEFAULT_TIER,
  expandTier,
  TIER_CONTROLLED_KEYS,
  TIER_PRESETS,
} from "./config";
export type {
  ComposedIntent,
  ComposedItem,
  CorrectionTarget,
  EngineListener,
} from "./engine";
export { composeIntent, Engine } from "./engine";
export type { KeyCommand, KeyState } from "./keymap";
export { installKeymap, isTypingTarget, keyCommand, TIER_BY_DIGIT } from "./keymap";
export type { DiffRun } from "./patch";
export { applyCorrectionToLines, applyPatch, wordDiff } from "./patch";
export type { IntentEvent, LocatedComponent, Mode, Rect } from "./types";
