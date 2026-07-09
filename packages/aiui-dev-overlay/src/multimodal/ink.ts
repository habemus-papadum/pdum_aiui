/**
 * The pen: a full-viewport canvas that turns primary-pointer drags into
 * strokes while the overlay is armed (ink mode). Policies under test:
 *
 *  - strokes FADE after config.inkFadeSec (0 = persist) — the hypothesis is
 *    that annotations are gestural, not documents, so they should evaporate
 *    unless a screenshot captured them;
 *  - C clears everything immediately;
 *  - a region shot "freezes" overlapping ink by compositing it into the
 *    captured image (see shot.ts), so what you circled travels with pixels.
 *
 * Graduated from the retired workbench lab. The canvas is a page-level overlay layer (not
 * inside a shadow root) so it can sit above the app under development; its
 * `mm-ink` class is styled by the modality's injected STYLES.
 */
import type { Rect } from "../intent-pipeline";

/** The default pen when a stroke carries no style of its own (all local ink). */
const DEFAULT_COLOR = "#ff5c87";
const DEFAULT_WIDTH = 3;

interface Stroke {
  points: Array<{ x: number; y: number }>;
  bornAt: number;
  /** Per-stroke style; absent means the default pen (local strokes). */
  color?: string;
  width?: number;
}

export class Ink {
  readonly canvas: HTMLCanvasElement;
  /** Null in environments without a 2D context (jsdom, exotic): stroke capture
   * still works for the pipeline; only the visible rendering degrades. */
  private readonly ctx: CanvasRenderingContext2D | null;
  private strokes: Stroke[] = [];
  private live: Stroke | undefined;
  /** In-progress strokes fed from a remote pen (see {@link remoteBegin}). */
  private liveRemote = new Map<string, Stroke>();
  private raf = 0;
  private fadeSec: () => number;
  private onStroke: (points: number, bounds: Rect) => void;
  private onAutoClear: () => void;
  private readonly onResize = () => this.resize();

  constructor(opts: {
    fadeSec: () => number;
    onStroke: (points: number, bounds: Rect) => void;
    onAutoClear: () => void;
  }) {
    this.fadeSec = opts.fadeSec;
    this.onStroke = opts.onStroke;
    this.onAutoClear = opts.onAutoClear;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "mm-ink";
    this.ctx = this.canvas.getContext("2d");
    this.resize();
    window.addEventListener("resize", this.onResize);

    this.canvas.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.shiftKey) {
        // Shift is the INSPECT modifier (shift-click opens the jump picker
        // from any armed mode) — it must never leave an ink dot behind.
        return;
      }
      try {
        this.canvas.setPointerCapture(e.pointerId);
      } catch {
        // Synthetic/exotic pointers have no capturable id; inking works anyway.
      }
      this.live = { points: [{ x: e.clientX, y: e.clientY }], bornAt: performance.now() };
    });
    this.canvas.addEventListener("pointermove", (e) => {
      if (this.live) {
        this.live.points.push({ x: e.clientX, y: e.clientY });
      }
    });
    const finish = () => {
      const stroke = this.live;
      this.live = undefined;
      if (!stroke || stroke.points.length < 2) {
        return;
      }
      stroke.bornAt = performance.now(); // fade clock starts at pen-up
      this.strokes.push(stroke);
      this.onStroke(stroke.points.length, bounds(stroke.points));
    };
    this.canvas.addEventListener("pointerup", finish);
    this.canvas.addEventListener("pointercancel", finish);

    // Only animate where we can actually paint (and where rAF exists).
    if (this.ctx && typeof requestAnimationFrame === "function") {
      const tick = () => {
        this.draw();
        this.raf = requestAnimationFrame(tick);
      };
      this.raf = requestAnimationFrame(tick);
    }
  }

  setActive(on: boolean): void {
    this.canvas.style.pointerEvents = on ? "auto" : "none";
  }

  clear(auto = false): void {
    const had = this.strokes.length > 0 || this.live !== undefined || this.liveRemote.size > 0;
    this.strokes = [];
    this.live = undefined;
    this.liveRemote.clear();
    if (had && auto) {
      this.onAutoClear();
    }
  }

  hasInk(): boolean {
    return this.strokes.length > 0;
  }

  // ── remote pen: strokes fed from another device (e.g. an iPad over the paint
  // stream). Points are in this page's viewport CSS pixels — the caller maps its
  // normalized wire coords first. A completed remote stroke joins the engine the
  // same way a local one does (via onStroke), so it composites into shots and
  // becomes part of the intent turn.

  remoteBegin(id: string, style: { color: string; width: number }, x: number, y: number): void {
    this.liveRemote.set(id, {
      points: [{ x, y }],
      bornAt: performance.now(),
      color: style.color,
      width: style.width,
    });
  }

  remotePoint(id: string, x: number, y: number): void {
    this.liveRemote.get(id)?.points.push({ x, y });
  }

  remoteEnd(id: string, x?: number, y?: number): void {
    const stroke = this.liveRemote.get(id);
    if (!stroke) {
      return;
    }
    this.liveRemote.delete(id);
    if (x !== undefined && y !== undefined) {
      stroke.points.push({ x, y });
    }
    if (stroke.points.length < 2) {
      return; // a tap — nothing to commit (matches local finish)
    }
    stroke.bornAt = performance.now(); // fade clock starts at pen-up
    this.strokes.push(stroke);
    this.onStroke(stroke.points.length, bounds(stroke.points));
  }

  remoteCancel(id: string): void {
    this.liveRemote.delete(id);
  }

  /** Draw current ink into another context (screenshot compositing). */
  compositeInto(
    ctx: CanvasRenderingContext2D,
    offsetX: number,
    offsetY: number,
    scale: number,
  ): void {
    for (const stroke of this.strokes) {
      drawStroke(ctx, stroke, 1, scale, -offsetX, -offsetY);
    }
    for (const stroke of this.liveRemote.values()) {
      drawStroke(ctx, stroke, 1, scale, -offsetX, -offsetY);
    }
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(window.innerWidth * dpr);
    this.canvas.height = Math.round(window.innerHeight * dpr);
  }

  private draw(): void {
    const ctx = this.ctx;
    if (!ctx) {
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    const fadeMs = this.fadeSec() * 1000;
    const now = performance.now();
    let expired = 0;
    for (const stroke of this.strokes) {
      let alpha = 1;
      if (fadeMs > 0) {
        const age = now - stroke.bornAt;
        alpha = Math.max(0, 1 - age / fadeMs);
        if (alpha === 0) {
          expired++;
          continue;
        }
      }
      drawStroke(ctx, stroke, alpha, 1, 0, 0);
    }
    if (this.live) {
      drawStroke(ctx, this.live, 1, 1, 0, 0);
    }
    for (const stroke of this.liveRemote.values()) {
      drawStroke(ctx, stroke, 1, 1, 0, 0);
    }
    if (
      expired > 0 &&
      expired === this.strokes.length &&
      !this.live &&
      this.liveRemote.size === 0
    ) {
      this.clear(true);
    }
  }

  dispose(): void {
    if (this.raf && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this.raf);
    }
    window.removeEventListener("resize", this.onResize);
    this.canvas.remove();
  }
}

function drawStroke(
  ctx: CanvasRenderingContext2D,
  stroke: Pick<Stroke, "points" | "color" | "width">,
  alpha: number,
  scale: number,
  dx: number,
  dy: number,
): void {
  const points = stroke.points;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = stroke.color ?? DEFAULT_COLOR;
  ctx.lineWidth = (stroke.width ?? DEFAULT_WIDTH) * scale;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo((points[0].x + dx) * scale, (points[0].y + dy) * scale);
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const point = points[i];
    // Midpoint smoothing — cheap and good enough for gesture ink.
    ctx.quadraticCurveTo(
      (prev.x + dx) * scale,
      (prev.y + dy) * scale,
      ((prev.x + point.x) / 2 + dx) * scale,
      ((prev.y + point.y) / 2 + dy) * scale,
    );
  }
  ctx.stroke();
  ctx.restore();
}

function bounds(points: Array<{ x: number; y: number }>): Rect {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
