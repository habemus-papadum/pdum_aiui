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
 * Graduated from the workbench. The canvas is a page-level overlay layer (not
 * inside a shadow root) so it can sit above the app under development; its
 * `mm-ink` class is styled by the modality's injected STYLES.
 */
import type { Rect } from "../intent-pipeline";

interface Stroke {
  points: Array<{ x: number; y: number }>;
  bornAt: number;
}

export class Ink {
  readonly canvas: HTMLCanvasElement;
  /** Null in environments without a 2D context (jsdom, exotic): stroke capture
   * still works for the pipeline; only the visible rendering degrades. */
  private readonly ctx: CanvasRenderingContext2D | null;
  private strokes: Stroke[] = [];
  private live: Stroke | undefined;
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
      if (e.button !== 0) {
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
    const had = this.strokes.length > 0 || this.live !== undefined;
    this.strokes = [];
    this.live = undefined;
    if (had && auto) {
      this.onAutoClear();
    }
  }

  hasInk(): boolean {
    return this.strokes.length > 0;
  }

  /** Draw current ink into another context (screenshot compositing). */
  compositeInto(
    ctx: CanvasRenderingContext2D,
    offsetX: number,
    offsetY: number,
    scale: number,
  ): void {
    for (const stroke of this.strokes) {
      drawStroke(ctx, stroke.points, 1, scale, -offsetX, -offsetY);
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
      drawStroke(ctx, stroke.points, alpha, 1, 0, 0);
    }
    if (this.live) {
      drawStroke(ctx, this.live.points, 1, 1, 0, 0);
    }
    if (expired > 0 && expired === this.strokes.length && !this.live) {
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
  points: Array<{ x: number; y: number }>,
  alpha: number,
  scale: number,
  dx: number,
  dy: number,
): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = "#ff5c87";
  ctx.lineWidth = 3 * scale;
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
