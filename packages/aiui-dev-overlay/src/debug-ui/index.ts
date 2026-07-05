/**
 * The shared debug UI: framework-free DOM panes for inspecting the multimodal
 * intent pipeline, live. Two homes, one implementation — the workbench lab
 * (over a live {@link Engine}) and the DevTools extension (over a channel trace
 * it live-follows). Prototyped as the workbench inspector; graduated here so
 * both render intent debugging identically, off the same fixtures.
 *
 * The pieces:
 *  - {@link EventPanes} — events / IR / timing / export over an {@link IntentEvent}
 *    stream. The lab's dock and the rich per-stage view for an event log.
 *  - {@link TraceView} — a whole channel trace rendered generically (works for
 *    any modality), embedding {@link EventPanes} where a stage carries an event log.
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
export type { TraceViewConfig } from "./trace-view";
export { TraceView } from "./trace-view";
