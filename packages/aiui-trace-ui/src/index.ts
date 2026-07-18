/**
 * The shared trace-debugger UI: framework-free DOM panes for inspecting the
 * multimodal intent pipeline, live. Multiple homes, one implementation — the
 * intent client's panel (TracesPane as a Solid island) and the console's
 * `/__aiui/debug` page (`aiui debug`). Prototyped in the retired workbench
 * lab; graduated so every home renders intent debugging identically, off the
 * same fixtures.
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
 *    {@link TracesPane} against the host-supplied channel port, honoring the
 *    `?session=` pin.
 *  - {@link renderJsonTree} — the dependency-free collapsible JSON widget the
 *    trace view's raw disclosures render structured stage data with.
 *  - {@link createTracePoll} — the revision-poll behind the live follow
 *    (the channel's `/debug/api/traces/:id/live` route).
 *
 * Dependency-free and browser-safe (DOM + the intent-pipeline core only).
 *
 * @packageDocumentation
 */

export type { MountDebugPageOptions } from "./debug-page";
export { mountDebugPage } from "./debug-page";
export type { JsonTreeOptions } from "./json-tree";
export { renderJsonTree } from "./json-tree";
export type { PreviewUrl } from "./paths";
export type { LiveTrace, TracePollOptions, TracePollResult, TraceStageLike } from "./sources";
export { createTracePoll } from "./sources";
export type { TraceViewConfig } from "./trace-view";
export { TraceView } from "./trace-view";
export type { TracesPaneOptions } from "./traces-pane";
export { TracesPane } from "./traces-pane";
