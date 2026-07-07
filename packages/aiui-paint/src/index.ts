/**
 * `aiui-paint` — iPad-to-browser remote paint stream.
 *
 * This is the **browser-safe** entry: the wire protocol and the desktop {@link
 * startPaintHost} controller. The Node coordinator is a separate entry point —
 * `@habemus-papadum/aiui-paint/server` (the host-neutral `createPaintBackend`,
 * mountable on any HTTP server) and `@habemus-papadum/aiui-paint/sidecar`
 * (that backend packaged as an aiui channel sidecar) — so `http`/`ws` imports
 * stay out of the browser bundle. The iPad client page is served by whichever
 * host mounts the backend.
 *
 * See `docs/proposals/ipad_browser_paint_stream_plan.md` for the architecture
 * and `docs/guide/paint-stream.md` for the flows.
 *
 * @packageDocumentation
 */
// Re-exported for the standalone host path: draw a remote pen onto a plain
// canvas surface (no overlay). `inkSurfaceSink(new InkSurface())` is a ready
// InkSink. The overlay integration uses its own sink (window.__AIUI__.remotePaint).
export { InkSurface, type InkSurfaceOptions } from "@habemus-papadum/aiui-ink";
export type {
  FrameSource,
  InkSink,
  NavHandlers,
  PaintHost,
  PaintHostOptions,
  RemoteInkTarget,
  SinkPoint,
  SinkStyle,
} from "./host";
export {
  displayCaptureSource,
  hostWsUrl,
  inkSurfaceSink,
  makeTransformZoom,
  startPaintHost,
  windowScroll,
} from "./host";
export type {
  CaptureState,
  ClientToRelay,
  HostToRelay,
  NormPoint,
  PaintIntent,
  PointerKind,
  RelayToClient,
  RelayToHost,
  SessionInfo,
  Signal,
  VideoStatus,
  ViewState,
  WireMessage,
  WireStyle,
} from "./protocol";
export { decode, encode, fromNorm, isPaintIntent, toNorm } from "./protocol";

/** The published package name — handy for smoke tests. */
export const name = "@habemus-papadum/aiui-paint";
