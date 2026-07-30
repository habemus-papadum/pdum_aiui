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
export type { IntentPipelineConfig, LinterVendor, LintTurnAction } from "./config";
export { DEFAULT_INTENT_CONFIG, expandTier, LINT_TURN_ACTIONS, LINTER_VENDORS } from "./config";
export type { EngineListener } from "./engine";
export { Engine } from "./engine";
export type { DiffRun } from "./patch";
export { applyPatch, wordDiff } from "./patch";
// The renderers a RE-ATTACHER shares with the lowered prompt (the
// defer-rendering rule: one implementation, however the item travels). The
// intent panel's oracle composes a realtime conversation from exactly these —
// same selection format, same element/cell block — without going near
// composeIntent, whose passes exist to order MANY events into ONE prompt.
export {
  renderAppSelection,
  renderCodeSelection,
  renderPrompt,
  renderShotMetadata,
  renderTabRecord,
} from "./render";
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
