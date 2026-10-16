/** Disposable diagnostic canvas over authoritative stroke snapshots. */
import {
  composeTransforms,
  type Dab,
  type InkDocument,
  type InkTransform,
  type PencilParams,
  planStroke,
  type StrokePlan,
} from "@habemus-papadum/aiui-pencil";

export interface PadView {
  raw: boolean;
  filtered: boolean;
  cusps: boolean;
  dabs: boolean;
  fill: boolean;
}
const COLORS = {
  raw: "rgba(60, 65, 80, 0.4)",
  rawDot: "rgba(60, 65, 80, 0.65)",
  filtered: "#008bb1",
  cusp: "#e12664",
  dab: "rgba(80, 90, 120, 0.5)",
  live: "#a76100",
};

export class PadRenderer {
  readonly canvas = document.createElement("canvas");
  private readonly ctx: CanvasRenderingContext2D | null;
  private host?: HTMLElement;
  private raf = 0;
  private ink?: InkDocument;
  private viewport = (): InkTransform => ({ x: 0, y: 0, scale: 1 });
  private unsubscribe?: () => void;
  private observer?: ResizeObserver;
  private plans = new Map<string, { revision: number; plan: StrokePlan }>();
  private view: PadView = { raw: false, filtered: false, cusps: false, dabs: false, fill: false };

  constructor() {
    this.canvas.className = "pad-canvas";
    this.ctx = this.canvas.getContext("2d");
  }

  setDocument(ink: InkDocument, viewport: () => InkTransform): void {
    this.viewport = viewport;
    if (this.ink === ink) return;
    this.unsubscribe?.();
    this.ink = ink;
    this.plans.clear();
    this.unsubscribe = ink.subscribe(this.invalidate);
    this.invalidate();
  }

  mount(host: HTMLElement): void {
    this.host = host;
    host.append(this.canvas);
    window.addEventListener("resize", this.invalidate);
    this.observer?.disconnect();
    this.observer = new ResizeObserver(this.invalidate);
    this.observer.observe(host);
    this.invalidate();
  }

  unmount(host: HTMLElement): void {
    if (this.host !== host) return;
    window.removeEventListener("resize", this.invalidate);
    this.observer?.disconnect();
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.host = undefined;
    this.canvas.remove();
  }

  dispose(): void {
    if (this.host) this.unmount(this.host);
    this.unsubscribe?.();
    this.plans.clear();
  }

  setView(view: PadView): void {
    this.view = view;
    this.invalidate();
  }

  invalidate = (): void => {
    if (!this.host || this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  };

  private draw(): void {
    const ctx = this.ctx;
    if (!ctx || !this.ink) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(this.canvas.clientWidth * dpr),
      h = Math.round(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!(this.view.raw || this.view.filtered || this.view.cusps || this.view.dabs)) return;
    const snapshot = this.ink.snapshot();
    const records = [
      ...snapshot.strokes,
      ...snapshot.live.filter((stroke) => stroke.tool === "draw"),
    ];
    const ids = new Set(records.map((stroke) => stroke.id));
    for (const id of this.plans.keys()) if (!ids.has(id)) this.plans.delete(id);
    const viewport = this.viewport();
    for (const stroke of records) {
      let cached = this.plans.get(stroke.id);
      if (!cached || cached.revision !== stroke.revision) {
        cached = { revision: stroke.revision, plan: planStroke(stroke.points, stroke.params) };
        this.plans.set(stroke.id, cached);
      }
      const transform = "transform" in stroke ? stroke.transform : { x: 0, y: 0, scale: 1 };
      const placement = composeTransforms(viewport, transform);
      const a = Math.cos(placement.rotation ?? 0) * placement.scale * dpr;
      const b = Math.sin(placement.rotation ?? 0) * placement.scale * dpr;
      ctx.save();
      ctx.setTransform(a, b, -b, a, dpr * placement.x, dpr * placement.y);
      this.drawPlan(ctx, cached.plan, stroke.params, !("endedAt" in stroke));
      ctx.restore();
    }
  }

  private drawPlan(
    ctx: CanvasRenderingContext2D,
    plan: StrokePlan,
    params: PencilParams,
    live: boolean,
  ): void {
    if (this.view.dabs) {
      for (const dab of plan.dabs) {
        drawDab(ctx, dab, this.view.fill ? params.color : undefined, live);
      }
    }

    if (this.view.raw && plan.raw.length > 0) {
      ctx.save();
      ctx.strokeStyle = COLORS.raw;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(plan.raw[0].x, plan.raw[0].y);
      for (const p of plan.raw.slice(1)) {
        ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      ctx.fillStyle = COLORS.rawDot;
      for (const p of plan.raw) {
        ctx.fillRect(p.x - 0.75, p.y - 0.75, 1.5, 1.5);
      }
      ctx.restore();
    }

    if (this.view.filtered && plan.filtered.length > 1) {
      ctx.save();
      ctx.strokeStyle = live ? COLORS.live : COLORS.filtered;
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.moveTo(plan.filtered[0].x, plan.filtered[0].y);
      for (const p of plan.filtered.slice(1)) {
        ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      ctx.restore();
    }

    if (this.view.cusps) {
      ctx.save();
      ctx.strokeStyle = COLORS.cusp;
      ctx.lineWidth = 1.5;
      plan.cusps.forEach((isCusp, i) => {
        if (!isCusp) {
          return;
        }
        const p = plan.filtered[i];
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
        ctx.stroke();
      });
      ctx.restore();
    }
  }
}

/**
 * One dab. Outlined by default — an outline shows you the ellipse's size and
 * ANGLE, which a filled blob at 30% alpha hides completely, and the angle is the
 * thing the tilt design lives or dies by.
 */
function drawDab(
  ctx: CanvasRenderingContext2D,
  dab: Dab,
  fill: string | undefined,
  live: boolean,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(
    dab.x,
    dab.y,
    Math.max(0.4, dab.rx),
    Math.max(0.4, dab.ry),
    dab.angle,
    0,
    Math.PI * 2,
  );
  if (fill !== undefined) {
    ctx.globalAlpha = dab.alpha;
    ctx.fillStyle = fill;
    ctx.fill();
  } else {
    ctx.globalAlpha = live ? 0.85 : 0.55;
    ctx.strokeStyle = live ? COLORS.live : COLORS.dab;
    ctx.lineWidth = 0.75;
    ctx.stroke();
  }
  ctx.restore();
}
