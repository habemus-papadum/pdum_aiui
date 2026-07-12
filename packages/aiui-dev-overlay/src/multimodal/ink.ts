/**
 * The pen — now an ADAPTER over `@habemus-papadum/aiui-ink`'s `InkSurface`
 * (unified in extension Phase C2a: the surface, the warp fade curve, and the
 * remote feed live in the package; this class keeps the modality's exact API
 * so modality.ts is untouched). The policies under test are unchanged:
 *
 *  - strokes PERSIST by default (`config.inkFadeSec === 0`) and are scoped to
 *    the page, not to a turn: they survive sends and abandoned turns, because
 *    a diagram you drew to talk over should still be there while you talk
 *    about it. (The old default was the opposite — annotations as gestures
 *    that evaporate unless a screenshot caught them. It read as data loss.)
 *  - `inkFadeSec > 0` opts back into *vanishing* ink (the hold → charge → pop
 *    warp curve — fade.ts in aiui-ink), on that many seconds;
 *  - C clears everything immediately — the only thing that does;
 *  - a region shot "freezes" overlapping ink by compositing it into the
 *    captured image (see shot.ts), so what you circled travels with pixels;
 *  - shift-drags never ink (shift is the INSPECT modifier), and taps commit
 *    nothing (`minCommitPoints: 2`);
 *  - a completed remote stroke (the iPad pen) joins the engine via the same
 *    `onStroke` local drawing uses.
 *
 * The canvas is a page-level overlay layer (not inside a shadow root) so it
 * can sit above the app under development; its `mm-ink` class is styled by
 * the modality's injected STYLES (the surface's inline defaults agree).
 */
import { boundsOf, type InkPoint, InkSurface } from "@habemus-papadum/aiui-ink";
import type { Rect } from "../intent-pipeline";

// The curve constants/functions live in aiui-ink now; re-exported so the
// existing tests (ink.test.ts) and any curve-reading UI keep their import.
export {
  type FadeStyle,
  fadeStyle,
  INK_CHARGE,
  INK_HOLD,
} from "@habemus-papadum/aiui-ink";

export class Ink {
  readonly canvas: HTMLCanvasElement;
  private readonly surface: InkSurface;

  constructor(opts: {
    fadeSec: () => number;
    onStroke: (points: number, bounds: Rect) => void;
    onAutoClear: () => void;
  }) {
    this.surface = new InkSurface({
      className: "mm-ink",
      fadeSec: opts.fadeSec,
      // Shift is the inspect modifier (shift-click opens the jump picker
      // from any armed mode) — it must never leave an ink dot behind.
      shouldCapture: (e) => !e.shiftKey,
      // A tap is nothing, never ink (matches the historical local finish).
      minCommitPoints: 2,
      onStrokeEnd: (stroke) => opts.onStroke(stroke.points.length, boundsOf(stroke.points)),
      // A completed remote stroke joins the engine the same way a local one
      // does, so it composites into shots and becomes part of the turn.
      onRemoteStrokeEnd: (_id, points) => opts.onStroke(points.length, boundsOf(points)),
      onAutoClear: opts.onAutoClear,
    });
    // The modality places the canvas itself (layers.append(ink.canvas)) —
    // appending moves the node out of the surface's default parent.
    this.canvas = this.surface.canvas;
  }

  setActive(on: boolean): void {
    this.surface.setActive(on);
  }

  clear(auto = false): void {
    this.surface.clear(auto);
  }

  hasInk(): boolean {
    return this.surface.hasInk();
  }

  /** How many committed strokes are on the canvas (the overlay's report). */
  strokeCount(): number {
    return this.surface.strokeCount();
  }

  /** Restart every stroke's fade clock (the ✒️→💨 chip flip). */
  restartFade(): void {
    this.surface.restartFade();
  }

  // ── remote pen: strokes fed from another device (e.g. an iPad over the
  // paint stream). Points are in this page's viewport CSS pixels — the caller
  // maps its normalized wire coords first.

  remoteBegin(id: string, style: { color: string; width: number }, x: number, y: number): void {
    this.surface.remoteBegin(id, { style, point: { x, y } });
  }

  remotePoint(id: string, x: number, y: number): void {
    this.surface.remotePoint(id, { x, y });
  }

  remoteEnd(id: string, x?: number, y?: number): void {
    this.surface.remoteEnd(id, x !== undefined && y !== undefined ? { x, y } : undefined);
  }

  remoteCancel(id: string): void {
    this.surface.remoteCancel(id);
  }

  /**
   * Draw current ink into another context (screenshot compositing) — always
   * at FULL style, never mid-warp (the surface enforces it).
   */
  compositeInto(
    ctx: CanvasRenderingContext2D,
    offsetX: number,
    offsetY: number,
    scale: number,
  ): void {
    this.surface.compositeInto(ctx, offsetX, offsetY, scale);
  }

  dispose(): void {
    this.surface.dispose();
  }
}

export type { InkPoint };
