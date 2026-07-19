/**
 * The intent pipeline: the framework-free, browser-safe core of the multimodal
 * intent tool. One append-only {@link IntentEvent} stream, the little state
 * machine that produces it ({@link Engine}), the V4A correction diff
 * machinery, and the multi-pass {@link composeIntent} compiler (`compose.ts`)
 * that folds a thread's events into the lowered prompt body (brackets inlined
 * at their positions).
 *
 * Prototyped in the since-retired workbench lab, graduated here so the intent
 * client and the channel's lowering processor share one implementation (and
 * one set of captured fixtures as the regression net). Zero DOM; the only
 * dependency is the equally realm-free modal kit (`aiui-viz/modal`), where
 * `wordDiff` comes from.
 *
 * @packageDocumentation
 */

export { composeIntent } from "./compose";
export type { IntentPipelineConfig, LinterVendor, LintTurnAction, OracleVendor } from "./config";
export {
  DEFAULT_INTENT_CONFIG,
  expandTier,
  LINT_TURN_ACTIONS,
  LINTER_VENDORS,
  ORACLE_VENDORS,
} from "./config";
export type { EngineListener } from "./engine";
export { Engine } from "./engine";
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
  TabInfo,
  TabRecord,
  TranscriptWord,
  VideoCaptureMode,
} from "./types";
