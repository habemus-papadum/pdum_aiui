/** Disposable Canvas views over editable ink. */
import { planStroke, type StrokePlan } from "./dabs";
import {
  type InkCapture,
  type InkDocument,
  type InkErasure,
  type InkStroke,
  previewStrokes,
} from "./document";
import { type FadeStyle, FULL_STYLE } from "./fade";
import type { Rect } from "./geom";
import {
  clientToInk,
  composeTransforms,
  type InkTransform,
  invertTransform,
  transformRectBounds,
  validateTransform,
} from "./geometry";
import { GrainCache } from "./grain";
import { type Layer, makeLayer } from "./layer";
import type { InkPresentation } from "./presentation";
import { applyGrain, boundsOfDabs, stampDabs } from "./stamp";

export interface CanvasInkViewOptions {
  document: InkDocument;
  target?: HTMLElement;
  presentation?: InkPresentation;
  viewport?: InkTransform;
  className?: string;
  background?: () => string | undefined;
  cacheBytes?: number;
}
interface Tile {
  key: string;
  layer: Layer;
  bytes: number;
}
const IDENTITY: InkTransform = { x: 0, y: 0, scale: 1 };

/** Union of swept disks, including coverage between input samples. */
export function eraseCoverage(layer: Layer, erasures: readonly InkErasure[]): void {
  const ctx = layer.ctx;
  ctx.save();
  ctx.translate(-layer.ox, -layer.oy);
  ctx.globalCompositeOperation = "destination-out";
  ctx.globalAlpha = 1;
  ctx.fillStyle = "black";
  for (const mask of erasures) {
    ctx.beginPath();
    for (let i = 0; i < mask.points.length; i++) {
      const a = mask.points[i],
        b = mask.points[i + 1];
      ctx.moveTo(a.x + a.radius, a.y);
      ctx.arc(a.x, a.y, a.radius, 0, Math.PI * 2);
      if (!b) continue;
      const dx = b.x - a.x,
        dy = b.y - a.y,
        distance = Math.hypot(dx, dy);
      if (distance <= Math.abs(a.radius - b.radius)) continue;
      const q = (a.radius - b.radius) / distance,
        s = Math.sqrt(1 - q * q);
      const ux = dx / distance,
        uy = dy / distance;
      const nx = ux * q - uy * s,
        ny = uy * q + ux * s;
      const mx = ux * q + uy * s,
        my = uy * q - ux * s;
      ctx.moveTo(a.x + nx * a.radius, a.y + ny * a.radius);
      ctx.lineTo(a.x + mx * a.radius, a.y + my * a.radius);
      ctx.lineTo(b.x + mx * b.radius, b.y + my * b.radius);
      ctx.lineTo(b.x + nx * b.radius, b.y + ny * b.radius);
      ctx.closePath();
    }
    ctx.fill();
  }
  ctx.restore();
}
function intersect(a: Rect, b: Rect): Rect | undefined {
  const x = Math.max(a.x, b.x),
    y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x,
    h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : undefined;
}

export class CanvasInkView {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private viewport: InkTransform;
  private tiles = new Map<string, Tile>();
  private plans = new Map<
    string,
    {
      points: InkStroke["points"];
      params: InkStroke["params"];
      plan: StrokePlan;
    }
  >();
  private grain = new GrainCache();
  private raf = 0;
  private active = true;
  private disposed = false;
  private width = 1;
  private height = 1;
  private density = 1;
  private cachedBytes = 0;
  private frames = 0;
  private computations = 0;
  private off: () => void;
  private offPresentation?: () => void;
  private resizeObserver?: ResizeObserver;
  private media?: MediaQueryList;

  constructor(private options: CanvasInkViewOptions) {
    this.viewport = { ...(options.viewport ?? IDENTITY) };
    validateTransform(this.viewport);
    this.canvas = document.createElement("canvas");
    this.canvas.className = options.className ?? "aiui-pencil";
    Object.assign(this.canvas.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
      pointerEvents: "none",
      touchAction: "none",
    });
    this.ctx = this.canvas.getContext("2d");
    options.target?.append(this.canvas);
    this.off = options.document.subscribe(() => this.invalidate());
    this.offPresentation = options.presentation?.subscribe(() => this.invalidate());
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.invalidate());
      this.resizeObserver.observe(this.canvas);
    }
    window.addEventListener("resize", this.invalidate);
    this.watchDpr();
    this.invalidate();
  }
  getViewport(): InkTransform {
    return { ...this.viewport };
  }
  setViewport(viewport: InkTransform): void {
    validateTransform(viewport);
    this.viewport = { ...viewport };
    this.invalidate();
  }
  clientToInk(point: { x: number; y: number }): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return clientToInk(point, this.viewport, { x: rect.left, y: rect.top });
  }
  setActive(active: boolean): void {
    this.active = active;
    if (!active && this.raf) cancelAnimationFrame(this.raf);
    if (!active) this.raf = 0;
    if (active) this.invalidate();
  }
  evictCache(): void {
    this.tiles.clear();
    this.cachedBytes = 0;
    this.invalidate();
  }
  invalidateGeometry(): void {
    this.plans.clear();
    this.evictCache();
  }
  size(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }
  report(): {
    frames: number;
    computations: number;
    cacheBytes: number;
    tiles: number;
    scheduled: boolean;
  } {
    return {
      frames: this.frames,
      computations: this.computations,
      cacheBytes: this.cachedBytes,
      tiles: this.tiles.size,
      scheduled: this.raf !== 0,
    };
  }
  invalidate = (): void => {
    if (
      this.disposed ||
      !this.active ||
      this.raf ||
      !this.ctx ||
      typeof requestAnimationFrame === "undefined"
    )
      return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      if (!this.canvas.isConnected) return;
      this.render();
      if (this.options.presentation?.animating()) this.invalidate();
    });
  };
  render(): void {
    this.paint(
      this.canvas.clientWidth || this.width,
      this.canvas.clientHeight || this.height,
      window.devicePixelRatio || 1,
    );
  }
  private paint(width: number, height: number, density: number, capture?: InkCapture): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.width = width;
    this.height = height;
    this.density = density;
    const w = Math.max(1, Math.round(width * density)),
      h = Math.max(1, Math.round(height * density));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const snapshot = this.options.document.snapshot();
    const strokes = capture?.strokes ?? previewStrokes(snapshot);
    const sourceRecords = new Map(snapshot.strokes.map((stroke) => [stroke.id, stroke]));
    const live = capture ? [] : snapshot.live.filter((draft) => draft.tool === "draw");
    const ids = new Set([...strokes, ...live].map((stroke) => stroke.id));
    for (const id of this.plans.keys()) if (!ids.has(id)) this.plans.delete(id);
    for (const [id, tile] of this.tiles)
      if (!ids.has(id)) {
        this.cachedBytes -= tile.bytes;
        this.tiles.delete(id);
      }
    for (const stroke of strokes)
      this.paintStroke(
        stroke,
        capture
          ? FULL_STYLE
          : (this.options.presentation?.style(sourceRecords.get(stroke.id) ?? stroke) ??
              FULL_STYLE),
      );
    for (const draft of live)
      this.paintStroke(
        { ...draft, tool: "draw", endedAt: draft.startedAt, transform: IDENTITY, erasures: [] },
        FULL_STYLE,
      );
    const background = this.options.background?.();
    if (background) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = "destination-over";
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = "source-over";
    }
    this.frames++;
  }
  private paintStroke(stroke: InkStroke, style: FadeStyle): void {
    if (style.alpha <= 0 || !this.ctx) return;
    let computed = this.plans.get(stroke.id);
    if (!computed || computed.points !== stroke.points || computed.params !== stroke.params) {
      computed = {
        points: stroke.points,
        params: stroke.params,
        plan: planStroke(stroke.points, stroke.params),
      };
      this.plans.set(stroke.id, computed);
      this.computations++;
    }
    const bounds = boundsOfDabs(computed.plan.dabs, style.widthScale);
    if (!bounds) return;
    const transform = composeTransforms(this.viewport, stroke.transform);
    const visibleBounds = transformRectBounds(
      { x: 0, y: 0, w: this.width, h: this.height },
      invertTransform(transform),
    );
    const clipped = intersect(
      { x: bounds.x - 2, y: bounds.y - 2, w: bounds.w + 4, h: bounds.h + 4 },
      visibleBounds,
    );
    if (!clipped) return;
    const density = this.density * transform.scale;
    const key = JSON.stringify([
      stroke.revision,
      stroke.erasures,
      style.widthScale,
      style.glow,
      style.hollow,
      density,
      clipped,
    ]);
    let tile = this.tiles.get(stroke.id);
    if (!tile || tile.key !== key) {
      if (tile) {
        this.cachedBytes -= tile.bytes;
        this.tiles.delete(stroke.id);
      }
      const layer = makeLayer(clipped, density);
      stampDabs(
        layer,
        computed.plan.dabs,
        0,
        computed.plan.dabs.length,
        stroke.params.color,
        style,
      );
      applyGrain(layer, this.grain, stroke.params.grain, stroke.params.grainScale);
      eraseCoverage(layer, stroke.erasures);
      tile = { key, layer, bytes: layer.canvas.width * layer.canvas.height * 4 };
      const budget = this.options.cacheBytes ?? 32 * 1024 * 1024;
      if (tile.bytes <= budget) {
        while (this.cachedBytes + tile.bytes > budget && this.tiles.size) {
          const oldest = this.tiles.entries().next().value;
          if (!oldest) break;
          this.cachedBytes -= oldest[1].bytes;
          this.tiles.delete(oldest[0]);
        }
        this.tiles.set(stroke.id, tile);
        this.cachedBytes += tile.bytes;
      }
    }
    const ctx = this.ctx,
      layer = tile.layer;
    const cosine = Math.cos(transform.rotation ?? 0);
    const sine = Math.sin(transform.rotation ?? 0);
    const scale = this.density * transform.scale;
    ctx.save();
    ctx.setTransform(
      scale * cosine,
      scale * sine,
      -scale * sine,
      scale * cosine,
      this.density * transform.x,
      this.density * transform.y,
    );
    ctx.globalAlpha = style.alpha;
    ctx.drawImage(layer.canvas, layer.ox, layer.oy, layer.w, layer.h);
    ctx.restore();
  }
  renderCapture(
    capture: InkCapture,
    width: number,
    height: number,
    density = 1,
  ): HTMLCanvasElement {
    const view = new CanvasInkView({
      ...this.options,
      target: undefined,
      presentation: undefined,
      viewport: this.viewport,
    });
    try {
      view.setActive(false);
      view.paint(width, height, density, capture);
      return view.canvas;
    } finally {
      view.dispose();
    }
  }
  dispose(): void {
    this.disposed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.off();
    this.offPresentation?.();
    this.resizeObserver?.disconnect();
    this.media?.removeEventListener("change", this.dprChanged);
    window.removeEventListener("resize", this.invalidate);
    this.tiles.clear();
    this.plans.clear();
    this.cachedBytes = 0;
    this.canvas.remove();
  }
  private dprChanged = (): void => {
    this.watchDpr();
    this.evictCache();
  };
  private watchDpr(): void {
    this.media?.removeEventListener("change", this.dprChanged);
    if (typeof window.matchMedia !== "function") return;
    this.media = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    this.media.addEventListener("change", this.dprChanged);
  }
}
export function createCanvasInkView(options: CanvasInkViewOptions): CanvasInkView {
  return new CanvasInkView(options);
}
