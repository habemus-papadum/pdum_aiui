/**
 * The intent pipeline: the framework-free, browser-safe core of the multimodal
 * intent tool. One append-only {@link IntentEvent} stream, the little state
 * machine that produces it ({@link Engine}), the V4A correction diff
 * machinery, and the {@link composeIntent} pass that folds a thread's events
 * into the lowered prompt body (brackets inlined at their positions).
 *
 * Prototyped in the since-retired workbench lab, graduated here so the intent
 * client and the channel's lowering processor share one implementation (and
 * one set of captured fixtures as the regression net). Zero DOM; the only
 * dependency is the equally realm-free modal kit (`aiui-viz/modal`), where
 * `wordDiff` comes from.
 *
 * @packageDocumentation
 */

export type { IntentPipelineConfig } from "./config";
export { DEFAULT_INTENT_CONFIG, expandTier } from "./config";
export type { EngineListener } from "./engine";
export { composeIntent, Engine } from "./engine";
export type { DiffRun } from "./patch";
export { applyPatch, wordDiff } from "./patch";
export { renderPrompt, renderTabRecord } from "./render";
export type {
  AppSelection,
  CodeSelection,
  ComposedIntent,
  ComposedItem,
  ComposeOptions,
  IntentEvent,
  LocatedCell,
  LocatedComponent,
  Mode,
  PromptSpan,
  Rect,
  ShotShare,
  TabRecord,
  TranscriptWord,
  VideoCaptureMode,
} from "./types";
