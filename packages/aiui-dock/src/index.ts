/**
 * @habemus-papadum/aiui-dock — the voice dock: both voice engines embedded in
 * an aiui page, wired to its own tools, with viewers and a key field. Mount
 * `<VoiceDock />` once beside the app (the app template's `main.tsx` and the
 * gallery shell do); see dock.tsx for the shape and the key posture.
 */
export type { BackendAvailability, DockBackend, DockBackendId } from "./backends";
export { availableBackends, DOCK_BACKENDS, probeServer } from "./backends";
export type { VoiceDockProps } from "./dock";
export { VoiceDock } from "./dock";
export type { DockSurface } from "./project";
export { activeNamespaces, projectSurface } from "./project";
export { DOCK_STYLES } from "./styles";
