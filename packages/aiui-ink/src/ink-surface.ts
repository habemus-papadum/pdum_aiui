/**
 * A reusable canvas ink surface.
 *
 * One `InkSurface` is a transparent full-target canvas that turns pointer drags
 * into strokes AND accepts strokes fed in from elsewhere — so the same surface
 * backs both "ink on my own machine" and "ink coming off a remote pen" (an iPad
 * over the paint stream, say). Strokes carry their own color + width, optionally
 * fade, and can be composited into another context so annotations travel with a
 * screenshot.
 *
 * Coordinates are the surface's own CSS pixels. The surface is deliberately
 * unaware of any wire protocol's normalized 0..1 space — a caller streaming
 * strokes between two surfaces maps `norm ↔ px` at the boundary using {@link
 * InkSurface.size}. That keeps this package dependency-free and framework-free.
 *
 * Graduated from the overlay's internal `Ink` (multimodal/ink.ts), generalized
 * with per-stroke style and a remote feed.
 */
import {
  boundsOf,
  type InkPoint,
  pressureWidth,
  type Rect,
  type Stroke,
  type StrokeStyle,
  smoothedSegments,
  strokeAlpha,
} from "./strokes";

/** Default brush when a local stroke's style isn't overridden. */
const DEFAULT_COLOR = "#ff5c87";
const DEFAULT_WIDTH = 3;

export interface InkSurfaceOptions {
  /** Where to append the canvas. Defaults to `document.body`. */
  target?: HTMLElement;
  /** Fade lifetime in seconds; `0` (default) persists strokes until cleared. */
  fadeSec?: () => number;
  /** Brush color for LOCAL strokes. Defaults to a pink. Read per stroke-start. */
  color?: () => string;
  /** Brush width for LOCAL strokes, CSS px. Defaults to 3. Read per stroke-start. */
  width?: () => number;
  /** Capture local pointer input into strokes. Defaults to `true`. */
  localInput?: boolean;
  /** A local stroke began (pen-down). Fires before any points. */
  onStrokeStart?: (stroke: LocalStroke) => void;
  /** A point was appended to the in-flight local stroke. */
  onStrokePoint?: (id: string, point: InkPoint) => void;
  /** A local stroke completed (pen-up). `points` is the full committed list. */
  onStrokeEnd?: (stroke: LocalStroke) => void;
  /** Every stroke faded away on its own (nothing left on the surface). */
  onAutoClear?: () => void;
  /** CSS class for the canvas (default `aiui-ink`). Inline styles still apply. */
  className?: string;
}

/** The immutable header of a local stroke handed to the lifecycle callbacks. */
export interface LocalStroke extends StrokeStyle {
  id: string;
  points: InkPoint[];
}

export class InkSurface {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly opts: InkSurfaceOptions;
  private readonly target: HTMLElement;
  private strokes: Stroke[] = [];
  /** Live strokes by id — the local drag (at most one) and any remote strokes. */
  private liveById = new Map<string, Stroke>();
  private localLiveId: string | undefined;
  private seq = 0;
  private raf = 0;
  private cssWidth = 0;
  private cssHeight = 0;
  private readonly onResize = () => this.resize();

  constructor(opts: InkSurfaceOptions = {}) {
    this.opts = opts;
    this.target = opts.target ?? document.body;
    this.canvas = document.createElement("canvas");
    this.canvas.className = opts.className ?? "aiui-ink";
    // Sensible defaults so the surface works with no stylesheet; a className or
    // the target's own CSS can override. `touch-action: none` is essential on
    // touch devices — without it the browser eats pen drags as scroll/zoom.
    Object.assign(this.canvas.style, {
      position: "fixed",
      left: "0",
      top: "0",
      width: "100%",
      height: "100%",
      pointerEvents: "none",
      touchAction: "none",
    } satisfies Partial<CSSStyleDeclaration>);
    this.ctx = this.canvas.getContext("2d");
    this.resize();
    window.addEventListener("resize", this.onResize);
    this.target.append(this.canvas);

    if (opts.localInput ?? true) {
      this.bindLocalInput();
    }

    if (this.ctx && typeof requestAnimationFrame === "function") {
      const tick = () => {
        this.draw();
        this.raf = requestAnimationFrame(tick);
      };
      this.raf = requestAnimationFrame(tick);
    }
  }

  /** Toggle whether the canvas receives pointer events (local inking on/off). */
  setActive(on: boolean): void {
    this.canvas.style.pointerEvents = on ? "auto" : "none";
  }

  /** CSS-pixel size of the surface — what callers map normalized coords against. */
  size(): { width: number; height: number } {
    return { width: this.cssWidth, height: this.cssHeight };
  }

  hasInk(): boolean {
    return this.strokes.length > 0;
  }

  /** Bounds of everything currently on the surface, or `undefined` if empty. */
  inkBounds(): Rect | undefined {
    if (this.strokes.length === 0) {
      return undefined;
    }
    const all: InkPoint[] = [];
    for (const s of this.strokes) {
      all.push(...s.points);
    }
    return boundsOf(all);
  }

  clear(auto = false): void {
    const had = this.strokes.length > 0;
    this.strokes = [];
    this.liveById.clear();
    this.localLiveId = undefined;
    if (had && auto) {
      this.opts.onAutoClear?.();
    }
  }

  // ── remote feed ──────────────────────────────────────────────────────────
  // A stroke authored elsewhere (another browser's pen). Points are in THIS
  // surface's CSS pixels — the caller maps from its wire's normalized space
  // first (see the module doc).

  remoteBegin(id: string, init: { style: StrokeStyle; point: InkPoint }): void {
    const stroke: Stroke = {
      id,
      points: [init.point],
      color: init.style.color,
      width: init.style.width,
      bornAt: 0,
      live: true,
    };
    this.strokes.push(stroke);
    this.liveById.set(id, stroke);
  }

  remotePoint(id: string, point: InkPoint): void {
    this.liveById.get(id)?.points.push(point);
  }

  remoteEnd(id: string, point?: InkPoint): void {
    const stroke = this.liveById.get(id);
    if (!stroke) {
      return;
    }
    if (point) {
      stroke.points.push(point);
    }
    stroke.live = false;
    stroke.bornAt = this.now();
    this.liveById.delete(id);
  }

  remoteCancel(id: string): void {
    const stroke = this.liveById.get(id);
    if (!stroke) {
      return;
    }
    this.liveById.delete(id);
    const idx = this.strokes.indexOf(stroke);
    if (idx >= 0) {
      this.strokes.splice(idx, 1);
    }
  }

  /** Draw current ink into another context (for compositing into a screenshot). */
  compositeInto(
    ctx: CanvasRenderingContext2D,
    offsetX: number,
    offsetY: number,
    scale: number,
  ): void {
    for (const stroke of this.strokes) {
      drawStroke(ctx, stroke, 1, scale, -offsetX, -offsetY);
    }
  }

  dispose(): void {
    if (this.raf && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this.raf);
    }
    window.removeEventListener("resize", this.onResize);
    this.canvas.remove();
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private now(): number {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
  }

  private localPoint(e: PointerEvent): InkPoint {
    const rect = this.canvas.getBoundingClientRect();
    const point: InkPoint = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    // 0 pressure is what a mouse reports; treat only real pen/touch pressure as
    // meaningful so a mouse line stays a constant width.
    if (e.pointerType === "pen" || e.pointerType === "touch") {
      point.pressure = e.pressure;
    }
    return point;
  }

  private bindLocalInput(): void {
    this.canvas.addEventListener("pointerdown", (e) => {
      // Primary button for mouse; pen/touch always. Secondary mouse buttons are
      // left for the app (context menu, etc.).
      if (e.pointerType === "mouse" && e.button !== 0) {
        return;
      }
      try {
        this.canvas.setPointerCapture(e.pointerId);
      } catch {
        // Synthetic/exotic pointers have no capturable id; inking works anyway.
      }
      const id = `local-${this.seq++}`;
      const color = this.opts.color?.() ?? DEFAULT_COLOR;
      const width = this.opts.width?.() ?? DEFAULT_WIDTH;
      const stroke: Stroke = {
        id,
        points: [this.localPoint(e)],
        color,
        width,
        bornAt: 0,
        live: true,
      };
      this.strokes.push(stroke);
      this.liveById.set(id, stroke);
      this.localLiveId = id;
      this.opts.onStrokeStart?.({ id, color, width, points: stroke.points });
    });

    this.canvas.addEventListener("pointermove", (e) => {
      const id = this.localLiveId;
      if (id === undefined) {
        return;
      }
      const stroke = this.liveById.get(id);
      if (!stroke) {
        return;
      }
      // Coalesced events recover the high-frequency samples a pen emits between
      // rAFs — smoother lines, more faithful forwarding. Not in every browser.
      const coalesced = getCoalesced(e);
      for (const raw of coalesced) {
        const point = this.localPoint(raw);
        stroke.points.push(point);
        this.opts.onStrokePoint?.(id, point);
      }
    });

    const finish = (e: PointerEvent) => {
      const id = this.localLiveId;
      if (id === undefined) {
        return;
      }
      this.localLiveId = undefined;
      const stroke = this.liveById.get(id);
      this.liveById.delete(id);
      if (!stroke) {
        return;
      }
      stroke.live = false;
      stroke.bornAt = this.now(); // fade clock starts at pen-up
      this.opts.onStrokeEnd?.({
        id,
        color: stroke.color,
        width: stroke.width,
        points: stroke.points,
      });
      void e;
    };
    this.canvas.addEventListener("pointerup", finish);
    this.canvas.addEventListener("pointercancel", finish);
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    this.cssWidth = this.canvas.clientWidth || window.innerWidth;
    this.cssHeight = this.canvas.clientHeight || window.innerHeight;
    this.canvas.width = Math.round(this.cssWidth * dpr);
    this.canvas.height = Math.round(this.cssHeight * dpr);
  }

  private draw(): void {
    const ctx = this.ctx;
    if (!ctx) {
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    const fadeMs = this.opts.fadeSec ? this.opts.fadeSec() * 1000 : 0;
    const now = this.now();
    let expired = 0;
    for (const stroke of this.strokes) {
      const alpha = strokeAlpha(stroke, now, fadeMs);
      if (alpha === 0) {
        expired++;
        continue;
      }
      drawStroke(ctx, stroke, alpha, 1, 0, 0);
    }
    if (expired > 0 && expired === this.strokes.length && this.liveById.size === 0) {
      this.clear(true);
    }
  }
}

/** Best-effort high-frequency samples for a pointermove; `[e]` if unsupported. */
function getCoalesced(e: PointerEvent): PointerEvent[] {
  const fn = (e as PointerEvent & { getCoalescedEvents?: () => PointerEvent[] }).getCoalescedEvents;
  if (typeof fn === "function") {
    const events = fn.call(e);
    if (events.length > 0) {
      return events;
    }
  }
  return [e];
}

/** Render one stroke (dot for a single point, smoothed polyline otherwise). */
function drawStroke(
  ctx: CanvasRenderingContext2D,
  stroke: Stroke,
  alpha: number,
  scale: number,
  dx: number,
  dy: number,
): void {
  const points = stroke.points;
  if (points.length === 0) {
    return;
  }
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const tx = (x: number) => (x + dx) * scale;
  const ty = (y: number) => (y + dy) * scale;

  if (points.length === 1) {
    const p = points[0];
    const r = (pressureWidth(stroke.width, p.pressure) * scale) / 2;
    ctx.beginPath();
    ctx.arc(tx(p.x), ty(p.y), Math.max(0.5, r), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  ctx.lineWidth = pressureWidth(stroke.width, averagePressure(points)) * scale;
  ctx.beginPath();
  ctx.moveTo(tx(points[0].x), ty(points[0].y));
  for (const seg of smoothedSegments(points)) {
    ctx.quadraticCurveTo(tx(seg.cx), ty(seg.cy), tx(seg.x), ty(seg.y));
  }
  ctx.stroke();
  ctx.restore();
}

/** Mean pressure across a stroke's points (undefined if none carry pressure). */
function averagePressure(points: readonly InkPoint[]): number | undefined {
  let sum = 0;
  let n = 0;
  for (const p of points) {
    if (p.pressure !== undefined) {
      sum += p.pressure;
      n++;
    }
  }
  return n === 0 ? undefined : sum / n;
}
