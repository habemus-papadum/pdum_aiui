/**
 * The pen: a full-viewport canvas that turns primary-pointer drags into
 * strokes while the overlay is armed (ink mode). Policies under test:
 *
 *  - strokes PERSIST by default (`config.inkFadeSec === 0`) and are scoped to
 *    the page, not to a turn: they survive sends and abandoned turns, because
 *    a diagram you drew to talk over should still be there while you talk
 *    about it. (The old default was the opposite — annotations as gestures
 *    that evaporate unless a screenshot caught them. It read as data loss.)
 *  - `inkFadeSec > 0` opts back into *vanishing* ink, on that many seconds;
 *  - C clears everything immediately — the only thing that does;
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

// ── the vanishing curve ──────────────────────────────────────────────────────
// A linear fade is the wrong shape for gesture ink: the stroke spends its whole
// life visibly dying, so it looks *sick* from the moment it's drawn, and the
// actual disappearance — the only moment worth noticing — is the least visible
// part of it. This one does nothing at all until the end, then announces
// itself: a brief charge (the stroke thickens and heats toward white, still
// fully opaque), then a fast pop out of existence. A ship going to warp.

/** Fraction of a stroke's life at full, unaltered opacity — nothing happens. */
export const INK_HOLD = 0.8;
/** Of the life AFTER the hold, the fraction spent charging before the pop. */
export const INK_CHARGE = 0.6;
/** Peak extra line width, as a fraction: at the charge's end (+45%) and at the pop's (+95%). */
const CHARGE_STRETCH = 0.45;
const POP_STRETCH = 0.5;
/** How far the colour is pulled toward white at full charge (0..1). Slight, on purpose. */
const CHARGE_GLOW = 0.55;

/** How a stroke should be painted right now. */
export interface FadeStyle {
  /** 0 means gone — the draw loop retires the stroke. */
  alpha: number;
  /** Multiplier on the stroke's line width: the warp stretch. */
  widthScale: number;
  /** 0..1, how far toward white the stroke has heated. */
  glow: number;
}

const FULL: FadeStyle = { alpha: 1, widthScale: 1, glow: 0 };

/**
 * The stroke's appearance at `ageMs` into a `fadeMs` life. Pure, so the curve
 * is testable without a canvas (the draw loop needs a 2D context; this does
 * not). `fadeMs <= 0` is permanent ink: always {@link FULL}.
 *
 * Three phases, by fraction of life `p`:
 *  - `p < 0.8` — nothing. Opaque, unstretched, uncoloured.
 *  - the next 60% of what remains — the CHARGE. Still fully opaque: the tell is
 *    a thickening and a warming toward white, not a dimming. (~0.7s at the 6s
 *    default.)
 *  - the last 40% — the POP. `1 - pop²`, so most of the disappearance happens
 *    in the final instants, while the stroke stretches wider still. (~0.5s.)
 */
export function fadeStyle(ageMs: number, fadeMs: number): FadeStyle {
  if (fadeMs <= 0) {
    return FULL;
  }
  const p = ageMs / fadeMs;
  if (p < INK_HOLD) {
    return FULL;
  }
  const q = Math.min(1, (p - INK_HOLD) / (1 - INK_HOLD));
  const charge = Math.min(1, q / INK_CHARGE);
  const pop = Math.max(0, (q - INK_CHARGE) / (1 - INK_CHARGE));
  return {
    alpha: Math.max(0, 1 - pop * pop),
    widthScale: 1 + CHARGE_STRETCH * charge + POP_STRETCH * pop,
    glow: charge,
  };
}

/** Pull a `#rgb`/`#rrggbb` colour toward white by `t` (0..1). Unparseable → unchanged. */
function heat(color: string, t: number): string {
  if (t <= 0) {
    return color;
  }
  const hex = color.trim().replace("#", "");
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
  if (!/^[0-9a-f]{6}$/i.test(full)) {
    return color; // a named colour, rgb(), a gradient — leave it alone
  }
  const channel = (i: number): number => {
    const value = Number.parseInt(full.slice(i * 2, i * 2 + 2), 16);
    return Math.round(value + (255 - value) * t);
  };
  return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`;
}

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

  /** How many committed strokes are on the canvas (the overlay's report). */
  strokeCount(): number {
    return this.strokes.length;
  }

  /**
   * Restart every stroke's fade clock from now.
   *
   * Turning vanishing ink ON is the reason this exists: a stroke's `bornAt` is
   * when it was drawn, so ink that has been sitting on a permanent canvas for
   * two minutes is already older than any fade window — flipping the chip
   * would blink the whole drawing out of existence in one frame. Re-stamping
   * gives what is on screen the full fade you just asked for.
   *
   * Adjusting the duration does NOT call this: a stroke drawn 2s ago, under a
   * fresh 8s fade, should be 3/4 opaque, not 8s young.
   */
  restartFade(): void {
    const now = performance.now();
    for (const stroke of this.strokes) {
      stroke.bornAt = now;
    }
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

  /**
   * Draw current ink into another context (screenshot compositing).
   *
   * Always at FULL style, never mid-warp: a shot freezes what you *circled*,
   * and a stroke caught two frames before it popped should reach the model as
   * the annotation it is, not as a half-erased ghost.
   */
  compositeInto(
    ctx: CanvasRenderingContext2D,
    offsetX: number,
    offsetY: number,
    scale: number,
  ): void {
    for (const stroke of this.strokes) {
      drawStroke(ctx, stroke, FULL, scale, -offsetX, -offsetY);
    }
    for (const stroke of this.liveRemote.values()) {
      drawStroke(ctx, stroke, FULL, scale, -offsetX, -offsetY);
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
      const style = fadeStyle(now - stroke.bornAt, fadeMs);
      if (style.alpha <= 0) {
        expired++;
        continue;
      }
      drawStroke(ctx, stroke, style, 1, 0, 0);
    }
    // A stroke still under the pen never fades — its clock starts at pen-up.
    if (this.live) {
      drawStroke(ctx, this.live, FULL, 1, 0, 0);
    }
    for (const stroke of this.liveRemote.values()) {
      drawStroke(ctx, stroke, FULL, 1, 0, 0);
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
  style: FadeStyle,
  scale: number,
  dx: number,
  dy: number,
): void {
  const points = stroke.points;
  const color = stroke.color ?? DEFAULT_COLOR;
  ctx.save();
  ctx.globalAlpha = style.alpha;
  ctx.strokeStyle = heat(color, CHARGE_GLOW * style.glow);
  ctx.lineWidth = (stroke.width ?? DEFAULT_WIDTH) * style.widthScale * scale;
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
