/**
 * The shared debug UI: framework-free DOM panes for inspecting the multimodal
 * intent pipeline, live. Two homes, one implementation — the workbench lab
 * (over a live {@link Engine}) and the DevTools extension (over a channel trace
 * it live-follows). Prototyped as the workbench inspector; graduated here so
 * both render intent debugging identically, off the same fixtures.
 *
 * The pieces:
 *  - {@link TraceView} — a whole channel trace rendered as a reading surface: a
 *    status header, the lowered prompt as a hero, and the recorded stages as
 *    compact, directional, filterable cards (see trace-cards.ts for the pure
 *    classification/coalescing under it). Generic — an unknown stage still gets
 *    a sensible card — so it works for any modality the debugger records.
 *  - {@link EventPanes} — events / IR / timing / export over an {@link IntentEvent}
 *    stream. A standalone view of one event log (the lab's dock still mounts it).
 *  - {@link renderJsonTree} — the dependency-free collapsible JSON widget the
 *    trace view's raw disclosures render structured stage data with.
 *  - {@link DebugSource} + {@link engineSource} / {@link traceLiveSource} —
 *    the small interface behind the panes: a live engine, or an HTTP poll of the
 *    channel's `/debug/api/traces/:id/live` route.
 *
 * Dependency-free and browser-safe (DOM + the intent-pipeline core only).
 *
 * @packageDocumentation
 */

export type { EventPanesConfig } from "./event-panes";
export { EventPanes } from "./event-panes";
export type { JsonTreeOptions } from "./json-tree";
export { renderJsonTree } from "./json-tree";
export type { PreviewUrl } from "./paths";
export { defaultPreviewUrl } from "./paths";
export type {
  DebugSource,
  LiveTrace,
  TraceLiveOptions,
  TracePollOptions,
  TracePollResult,
  TraceStageLike,
} from "./sources";
export {
  createTracePoll,
  engineSource,
  extractIntentEvents,
  staticSource,
  traceLiveSource,
} from "./sources";
export { DEBUG_UI_CSS, injectDebugUiStyles } from "./styles";
export type {
  CardCategory,
  CardDirection,
  LiveSegment,
  PatchLine,
  PatchLineKind,
  PromptSegment,
  StageClass,
  TraceCard,
  TraceOutcome,
  TraceState,
} from "./trace-cards";
export {
  buildCards,
  cardVisible,
  classifyStage,
  correctionLines,
  eventTypesSummary,
  liveOpenLine,
  liveResolvedSummary,
  liveToolSegments,
  loweredPromptText,
  parsePatchLines,
  parseShotBlocks,
  savedFrameFiles,
  splitLoweredPrompt,
  traceOutcome,
} from "./trace-cards";
export type { TraceViewConfig } from "./trace-view";
export { TraceView } from "./trace-view";
