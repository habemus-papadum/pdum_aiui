/**
 * stroke-types.ts — the surface's data types, with no behaviour attached.
 *
 * Two faces live here. The INTERNAL records (`StrokeRecord`, `LiveStroke`) carry
 * a stroke's raster state — the baked tile, the wet buffer, how much is stamped —
 * and are used only inside `PencilSurface`. The PUBLIC face (`InkStroke`,
 * `InkState`, `InkEvent`, `StrokeEnd`, `PencilSurfaceOptions`, `Tool`) is the
 * reactive/config contract that `reactive.ts`, `remote.ts`, and the barrel
 * consume; `surface.ts` re-exports those names so no import site has to change.
 */

import type { Dab } from "./dabs";
import type { Rect } from "./geom";
import type { Layer } from "./layer";
import type { PencilParams } from "./pencil";
import type { PenSample } from "./telemetry";

/** Draw graphite, or take it off. An eraser is a stroke like any other. */
export type Tool = "draw" | "erase";

/** How many completed strokes stay individually addressable. Undo depth == this. */
export const DEFAULT_RETENTION = 64;

// ── strokes ──────────────────────────────────────────────────────────────────

export interface StrokeRecord {
  id: string;
  tool: Tool;
  params: PencilParams;
  dabs: Dab[];
  points: PenSample[];
  bornAt: number;
  /** The baked, grained raster. Rebuilt when the warp style moves. */
  tile: Layer | undefined;
  /** Which warp style `tile` was baked at — `"full"` for the un-warped bake. */
  tileKey: string;
}

export interface LiveStroke {
  id: string;
  tool: Tool;
  params: PencilParams;
  bornAt: number;
  samples: PenSample[];
  dabs: Dab[];
  /** Accumulated RAW (ungrained) coverage of the stable prefix. */
  wet: Layer | undefined;
  /** How many dabs are already baked into `wet`. */
  stamped: number;
  pointerId: number | undefined;
}

export interface StrokeEnd {
  id: string;
  tool: Tool;
  points: PenSample[];
  bounds: Rect;
}

// ── the reactive face: the drawing, as data ──────────────────────────────────

/**
 * One stroke of the drawing, as raw material. `points` are the samples exactly
 * as captured (canvas CSS px) — re-plan them with `planStroke(points, params)`
 * to get every pipeline stage (filtered, cusps, densified, dabs), with the
 * widget's own brush (`surface.params()`) or any other.
 */
export interface InkStroke {
  id: string;
  tool: Tool;
  /** Never mutated after commit — safe to hold. A LIVE stroke's is a snapshot. */
  points: readonly PenSample[];
  /** Pen-DOWN time for a live stroke; pen-UP (the fade clock) once committed. */
  bornAt: number;
}

/**
 * The drawing, as data — what {@link PencilSurface.ink} returns.
 *
 * `strokes` is everything still part of the picture since the last clear:
 * retained strokes AND those flattened past the undo horizon (they lost their
 * *individual pixels*, not their identity as data). An eraser stroke is in
 * here too, `tool: "erase"` — it is part of the drawing. `live` is the strokes
 * in flight, each carrying every point captured so far: emissions may be
 * throttled, but a snapshot is cumulative, so no consumer ever misses a point.
 */
export interface InkState {
  strokes: readonly InkStroke[];
  live: readonly InkStroke[];
}

/**
 * `"strokes"`: the committed list changed — a commit, an undo, a clear, or a
 * fade-out. `"live"`: a stroke in flight grew (or began, or was cancelled).
 * Discrete human-rate events versus a 60–120 Hz firehose: subscribers throttle
 * the second and never the first (see `reactive.ts`, which does exactly that).
 */
export type InkEvent = "strokes" | "live";

export interface PencilSurfaceOptions {
  /** Where to append the canvas. Defaults to `document.body`. */
  target?: HTMLElement;
  /** The instrument, read per stroke-start (so a stroke keeps the brush it began with). */
  params: () => PencilParams;
  /** Draw or erase, read per stroke-start. */
  tool?: () => Tool;
  /** Vanishing-ink lifetime, seconds. `0` (default) persists until cleared. */
  fadeSec?: () => number;
  /**
   * Which exit a fading stroke takes. `"warp"` (default) is the gesture curve —
   * hold, charge, pop: a stroke ANNOUNCING its death. `"crossfade"` is the
   * remote preview's handoff (D3): a gentle dissolve that hides the moment the
   * video's copy takes over — width never stretches, so the preview never warps
   * away from the truth beneath it, and the baked tile is reused throughout.
   */
  fadeCurve?: () => "warp" | "crossfade";
  /** Capture local pointer input. Default true. */
  localInput?: boolean;
  /** Per-pointerdown veto (the overlay passes `!e.shiftKey` — shift is inspect). */
  shouldCapture?: (e: PointerEvent) => boolean;
  /** Minimum committed points. Default 1 (a tap is a dot). The overlay passes 2. */
  minCommitPoints?: number;
  /** How many strokes stay individually addressable: the undo depth. Read per commit. */
  retention?: () => number;
  /**
   * Opaque paper behind the ink, painted `destination-over` after the replay —
   * so erased areas read as PAPER, not as holes. Unset (the default) keeps the
   * canvas transparent, which the overlay use case requires: its ink floats
   * over a live page. Set it when the surface IS the page (the scratchpad), and
   * especially when it is captured: `captureStream` drops alpha, so a
   * transparent canvas streams as ink-on-black.
   */
  background?: () => string | undefined;
  /**
   * What happens to the ink when the canvas changes size (D4).
   *
   * `"keep"` (default): strokes stay at their absolute canvas coordinates — the
   * overlay's posture, where a resize means the page reflowed and the app is
   * expected to retire the ink anyway ({@link PencilSurface.clearAnimated}).
   * `"rescale"`: the drawing re-bakes proportionally — the scratchpad's posture,
   * where the plane is a component and nothing reflows inside a canvas. Stroke
   * width scales by the geometric mean of the two axes, so the drawing reads as
   * the same drawing, larger or smaller.
   */
  resize?: "keep" | "rescale";
  onStrokeStart?: (id: string, tool: Tool) => void;
  onStrokeEnd?: (stroke: StrokeEnd) => void;
  /** A REMOTE stroke completed — the iPad's pen, fed through `remote*`. */
  onRemoteStrokeEnd?: (stroke: StrokeEnd) => void;
  /** Every stroke faded away on its own; nothing is left. */
  onAutoClear?: () => void;
  className?: string;
}
