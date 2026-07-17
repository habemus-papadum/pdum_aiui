/**
 * The remote-pencil CLIENT KIT (`@habemus-papadum/aiui-pencil/client`).
 *
 * Two ways to consume it (owner, 2026-07-17):
 *
 *  - **The paved road**: render {@link PencilRemoteApp} and customize per
 *    application through the host-declared `RemotePresentation` (protocol.ts)
 *    — what the served `/pencil/` page does for every host.
 *  - **Full control**: compose your own page from the pieces — the display
 *    ({@link RemoteView}: plane/preview/coordinate correctness that must never
 *    be rebuilt), {@link SessionPicker}, {@link PencilStrip}, and the
 *    imperative cores ({@link bindPenInput}, {@link createPlaneTracker}).
 *
 * Solid components; the browser-only sibling of the framework-free library
 * root.
 */

export type { PencilRemoteAppOptions, Phase } from "./app";
export { PencilRemoteApp } from "./app";
export type { PenInputDeps, PenPreview, PenSink } from "./pen-input";
export { bindPenInput } from "./pen-input";
export type { SessionPickerProps } from "./picker";
export { SessionPicker } from "./picker";
export type { PlaneBox, PlaneTracker } from "./plane";
export { createPlaneTracker } from "./plane";
export type { ResolvedPresentation } from "./presentation";
export { FULL_PRESENTATION, resolvePresentation } from "./presentation";
export type { PencilStripProps } from "./strip";
export { PencilStrip } from "./strip";
export { REMOTE_APP_CSS } from "./styles";
export type { RemoteViewProps } from "./view";
export { RemoteView } from "./view";
