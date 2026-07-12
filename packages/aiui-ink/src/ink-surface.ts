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
import { CHARGE_GLOW, type FadeStyle, FULL_STYLE, fadeStyle, heat } from "./fade";
import {
  boundsOf,
  type InkPoint,
  pressureWidth,
  type Rect,
  type Stroke,
  type StrokeStyle,
  smoothedSegments,
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
  /**
   * Per-pointerdown veto for local capture (e.g. the overlay ignores
   * shift-drags — shift is its inspect modifier). Return false to pass the
   * gesture to whatever is underneath.
   */
  shouldCapture?: (e: PointerEvent) => boolean;
  /**
   * Minimum committed points for a finished stroke (local AND remote).
   * Default 1 — a tap is a dot (the paint surfaces' behavior). The overlay
   * passes 2: taps are nothing, never ink.
   */
  minCommitPoints?: number;
  /**
   * A REMOTE stroke completed (its `remoteEnd` arrived with enough points).
   * The overlay feeds these to the engine exactly like local strokes; the
   * extension's panel will relay them the same way (iPad ink, Phase C7).
   */
  onRemoteStrokeEnd?: (id: string, points: InkPoint[]) => void;
  /**
   * Anchor strokes to the DOCUMENT instead of the viewport: points are stored
   * in document coordinates (client + scroll) and the draw loop subtracts the
   * live scroll offset each frame, so strokes follow the page as it scrolls —
   * annotations stay glued to the content they mark. Content reflow (a resize
   * re-wrapping text) is deliberately NOT tracked: coordinates, not DOM
   * anchors. Remote-fed points are mapped the same way at ingestion (the wire
   * still speaks viewport CSS pixels). Off by default — the paint sidecar's
   * full-viewport surfaces don't scroll. (Extension proposal §13.6.)
   */
  documentAnchored?: boolean;
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

  /** How many committed strokes are on the surface. */
  strokeCount(): number {
    return this.strokes.filter((s) => !s.live).length;
  }

  /**
   * Restart every committed stroke's fade clock from now. Turning vanishing
   * ink ON is the reason this exists: `bornAt` is pen-up time, so ink that
   * sat on a permanent canvas for minutes is already older than any fade
   * window — flipping the chip would blink the whole drawing out in one
   * frame. Adjusting the DURATION deliberately does not call this.
   */
  restartFade(): void {
    const now = this.now();
    for (const stroke of this.strokes) {
      if (!stroke.live) {
        stroke.bornAt = now;
      }
    }
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
      points: [this.toStored(init.point)],
      color: init.style.color,
      width: init.style.width,
      bornAt: 0,
      live: true,
    };
    this.strokes.push(stroke);
    this.liveById.set(id, stroke);
  }

  remotePoint(id: string, point: InkPoint): void {
    this.liveById.get(id)?.points.push(this.toStored(point));
  }

  remoteEnd(id: string, point?: InkPoint): void {
    const stroke = this.liveById.get(id);
    if (!stroke) {
      return;
    }
    if (point) {
      stroke.points.push(this.toStored(point));
    }
    this.liveById.delete(id);
    if (stroke.points.length < (this.opts.minCommitPoints ?? 1)) {
      const at = this.strokes.indexOf(stroke);
      if (at >= 0) {
        this.strokes.splice(at, 1); // a remote tap below the floor: nothing
      }
      return;
    }
    stroke.live = false;
    stroke.bornAt = this.now();
    this.opts.onRemoteStrokeEnd?.(id, stroke.points);
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
      // Always FULL, never mid-warp: a shot freezes what you circled, and a
      // stroke caught two frames before it popped should reach the model as
      // the annotation it is, not as a half-erased ghost.
      drawStroke(ctx, stroke, FULL_STYLE, scale, -offsetX, -offsetY);
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

  /** The stored-coordinate origin: the live scroll offset when document-anchored. */
  private origin(): { x: number; y: number } {
    if (this.opts.documentAnchored) {
      return { x: window.scrollX, y: window.scrollY };
    }
    return { x: 0, y: 0 };
  }

  /** Map an externally-supplied (viewport CSS px) point into stored coordinates. */
  private toStored(point: InkPoint): InkPoint {
    const o = this.origin();
    return o.x === 0 && o.y === 0 ? point : { ...point, x: point.x + o.x, y: point.y + o.y };
  }

  private localPoint(e: PointerEvent): InkPoint {
    const rect = this.canvas.getBoundingClientRect();
    const o = this.origin();
    const point: InkPoint = { x: e.clientX - rect.left + o.x, y: e.clientY - rect.top + o.y };
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
      if (this.opts.shouldCapture !== undefined && !this.opts.shouldCapture(e)) {
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
      if (stroke.points.length < (this.opts.minCommitPoints ?? 1)) {
        // A tap below the commit floor: not ink — remove it entirely.
        const at = this.strokes.indexOf(stroke);
        if (at >= 0) {
          this.strokes.splice(at, 1);
        }
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
    // Document-anchored surfaces subtract the live scroll every frame — the
    // paint loop already runs per-rAF, so strokes track scrolling for free.
    const o = this.origin();
    let expired = 0;
    for (const stroke of this.strokes) {
      // Live strokes never fade — their clock starts at pen-up. Committed
      // strokes ride the warp curve (fade.ts): hold → charge → pop.
      const style = stroke.live ? FULL_STYLE : fadeStyle(now - stroke.bornAt, fadeMs);
      if (style.alpha <= 0) {
        expired++;
        continue;
      }
      drawStroke(ctx, stroke, style, 1, -o.x, -o.y);
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
  style: FadeStyle,
  scale: number,
  dx: number,
  dy: number,
): void {
  const points = stroke.points;
  if (points.length === 0) {
    return;
  }
  const color = heat(stroke.color, CHARGE_GLOW * style.glow);
  ctx.save();
  ctx.globalAlpha = style.alpha;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const tx = (x: number) => (x + dx) * scale;
  const ty = (y: number) => (y + dy) * scale;

  if (points.length === 1) {
    const p = points[0];
    const r = (pressureWidth(stroke.width, p.pressure) * style.widthScale * scale) / 2;
    ctx.beginPath();
    ctx.arc(tx(p.x), ty(p.y), Math.max(0.5, r), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  ctx.lineWidth = pressureWidth(stroke.width, averagePressure(points)) * style.widthScale * scale;
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
