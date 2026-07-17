/**
 * The shared trace-debugger UI: framework-free DOM panes for inspecting the
 * multimodal intent pipeline, live. Multiple homes, one implementation — the
 * intent client's panel (TracesPane as a Solid island), the `/__aiui/debug`
 * page this package's `./vite` plugin serves (`aiui debug`), and any pane
 * over a live {@link Engine}. Prototyped in the retired workbench lab;
 * graduated so all of them render intent debugging identically, off the same
 * fixtures.
 *
 * The pieces:
 *  - {@link TraceView} — a whole channel trace rendered as a reading surface: a
 *    status header, the lowered prompt as a hero, and the recorded stages as
 *    compact, directional, filterable cards (see trace-cards.ts for the pure
 *    classification/coalescing under it). Generic — an unknown stage still gets
 *    a sensible card — so it works for any modality the debugger records.
 *  - {@link TracesPane} — the trace debugger's whole surface: the trace list
 *    (session-filtered, follow-newest) over a live-followed {@link TraceView}.
 *    The `/__aiui/debug` page mounts exactly this.
 *  - {@link mountDebugPage} — the `/__aiui/debug` bootstrap: a full-viewport
 *    {@link TracesPane} against the injected channel port, honoring the
 *    `?session=` pin.
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

export type { MountDebugPageOptions } from "./debug-page";
export { mountDebugPage } from "./debug-page";
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
  HeroPrompt,
  LiveSegment,
  PatchLine,
  PatchLineKind,
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
  heroPrompt,
  liveOpenLine,
  liveResolvedSummary,
  liveToolSegments,
  loweredPromptText,
  parsePatchLines,
  savedFrameFiles,
  traceOutcome,
} from "./trace-cards";
export type { TraceViewConfig } from "./trace-view";
export { TraceView } from "./trace-view";
export type { TracesPaneOptions } from "./traces-pane";
export { inSession, TracesPane, traceRowParts } from "./traces-pane";
