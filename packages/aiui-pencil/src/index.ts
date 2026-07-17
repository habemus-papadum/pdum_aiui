/**
 * `aiui-pencil` — one instrument, three surfaces.
 *
 * A pencil whose range lives in your hand: pressure darkens and broadens it,
 * laying it over turns the contact patch elliptical and it becomes charcoal.
 * Textured strokes, a real eraser, and vanishing ink, on a raster surface that
 * keeps stroke identity exactly as long as it needs to and not one frame longer.
 *
 * Design: `docs/proposals/aiui-pencil.md`. Plan and status:
 * `docs/proposals/aiui-pencil-plan.md`. Supersedes `aiui-ink` and `aiui-paint`.
 *
 * **What exists today is layer 1: the pure stroke pipeline** — everything from a
 * `PointerEvent` to a list of dabs, with no DOM anywhere in it. The renderer
 * (`PencilSurface`), the remote protocol, and the command bus are phases 3, 5,
 * and 6 of the plan.
 *
 * The pipeline, end to end:
 *
 * ```text
 *   PointerEvent → penSample()     normalize; derive whichever orientation pair
 *                                  the browser withheld           (telemetry.ts)
 *                → filterSamples() causal One-Euro low-pass          (filter.ts)
 *                → detectCusps()   the corners a spline must NOT
 *                                  smooth through                   (corners.ts)
 *                → densify()       centripetal Catmull-Rom, broken
 *                                  at those corners                  (spline.ts)
 *                → resample…()     onto the dab grid, by ARC LENGTH     (geom.ts)
 *                → dabAt()         pressure/tilt/azimuth/velocity
 *                                  → the stamp                        (dabs.ts)
 * ```
 *
 * {@link planStroke} runs all of it and **keeps every intermediate stage**, which
 * is what the Lab draws — a tuning rig that can only show you the final stroke
 * can tell you *that* it looks wrong, never *where* it went wrong.
 *
 * @packageDocumentation
 */

export { ClientSession, type ClientSessionOptions } from "./client-session";
export { type CuspConfig, detectCusps, turnAt } from "./corners";
export {
  type Dab,
  dabAt,
  effectivePressure,
  filterSamples,
  planStroke,
  ramp,
  type StrokePlan,
  speedsOf,
} from "./dabs";
export {
  CHARGE_GLOW,
  crossfadeStyle,
  type FadeStyle,
  FULL_STYLE,
  fadeStyle,
  heat,
  INK_CHARGE,
  INK_HOLD,
  isFullStyle,
} from "./fade";
export { OneEuro, type OneEuroConfig, PointFilter, smoothingAlpha } from "./filter";
export {
  boundsOf,
  dist,
  lerp,
  lerpAngle,
  normalizeAngle,
  polygonArea,
  polylineLength,
  type Rect,
  resampleByArcLength,
  type Vec,
} from "./geom";
export { GrainCache, grainTexture, noiseField } from "./grain";
// host-session.ts / client-session.ts — the two ends of the remote pencil as
// consumables: relay socket, WebRTC lifecycle, videoStatus. An integrator
// constructs one of these instead of ever touching an RTCPeerConnection.
export {
  clientRelayUrl,
  HostSession,
  type HostSessionOptions,
  type HostSessionStatus,
  hostRelayUrl,
} from "./host-session";
export {
  NEW_STROKE,
  type PencilMode,
  type PencilParams,
  type Ramp,
  resolveParams,
  SKETCH,
  type StrokeContext,
  WRITE,
} from "./pencil";
// protocol.ts — the remote-pencil wire: ink intent up, the mode engine's bar
// down, WebRTC signaling across (D1: video is a track, never JPEG; D3: no frame
// metadata of any kind). Pure, shared by the relay (node) and both browsers.
export {
  type CaptureState,
  type ClientToRelay,
  decode,
  encode,
  fromNorm,
  type HostToRelay,
  type InkIntent,
  isInkIntent,
  type PointerKind,
  PROTOCOL_VERSION,
  type RelayToClient,
  type RelayToHost,
  type RemotePresentation,
  type SessionInfo,
  type Signal,
  type StrokeOverrides,
  type Surface,
  toNorm,
  type VideoStatus,
  type WireMessage,
  type WirePoint,
} from "./protocol";
// reactive.ts — the Solid face of a surface: the drawing as signals (committed
// immediately; the live stroke throttled but LOSSLESS — cumulative snapshots).
export {
  DEFAULT_LIVE_HZ,
  type InkSignals,
  type InkSource,
  inkSignals,
} from "./reactive";
// remote.ts — the endpoint cores (no socket in them), and the preview fade
// window: ~500 ms from pen-up (paint v1's proven policy, D3), sized from the
// receiver's measured delays when stats are available.
export {
  fadeWindowMs,
  type LinkStats,
  PREVIEW_FADE_MS,
  RemoteClient,
  type RemoteClientOptions,
  RemoteHost,
  type RemoteHostOptions,
} from "./remote";
export { blendSample, catmullRom, type DensifyConfig, densify } from "./spline";
export {
  type InkEvent,
  type InkState,
  type InkStroke,
  PencilSurface,
  type PencilSurfaceOptions,
  type StrokeEnd,
  type Tool,
} from "./surface";
export {
  emptyTelemetry,
  IDLE_GAP_MS,
  type InputReport,
  inputReport,
  median,
  observe,
  type PenKind,
  type PenSample,
  type PenSupport,
  type PointerLike,
  penKind,
  penSample,
  penSupport,
  type Range,
  sphericalFromTilt,
  type Telemetry,
  type TiltVerdict,
  tiltFromSpherical,
  tiltVerdict,
  varied,
} from "./telemetry";

/** The published package name — handy for smoke tests. */
export const name = "@habemus-papadum/aiui-pencil";
