/**
 * pad-renderer.ts — the imperative island. A canvas, a rAF loop, and no signals
 * anywhere inside it.
 *
 * This is a **diagnostic** renderer, not the pencil. It draws the *stages of the
 * pipeline* — raw samples, filtered samples, detected corners, the resampled dab
 * grid, and the dabs themselves as outlines — because phase 1's question is
 * "what is the pen telling us, and what is the math doing with it", and a
 * renderer that only showed the finished stroke could not answer either. The real
 * textured, grained, erasable `PencilSurface` is phase 3, and it will replace the
 * dab-drawing here while keeping this overlay as a debug layer.
 *
 * The two rules from the frontend guide that this file exists to obey:
 *
 *  - **the hot loop never touches a signal.** Parameters, view flags, and the
 *    re-planned strokes are PUSHED in through setters by `createEffect` in the
 *    component; the loop reads plain fields.
 *  - **the durable node is adopted, not owned.** `mount`/`unmount` are written so
 *    that a hot-swapped successor component which has already adopted the canvas
 *    is never un-parented by its predecessor's cleanup (the "still mine?" guard).
 */

import {
  type Dab,
  type PencilParams,
  planStroke,
  type StrokePlan,
} from "@habemus-papadum/aiui-pencil";
import type { PenRecorder } from "./capture";

/** Which stages of the pipeline to draw. Pushed in; never read reactively. */
export interface PadView {
  raw: boolean;
  filtered: boolean;
  cusps: boolean;
  dabs: boolean;
  fill: boolean;
}

const COLORS = {
  raw: "rgba(232, 235, 240, 0.22)",
  rawDot: "rgba(232, 235, 240, 0.5)",
  filtered: "#4cc9f0",
  cusp: "#ff5c87",
  dab: "rgba(232, 235, 240, 0.30)",
  live: "rgba(255, 209, 102, 0.9)",
};

export class PadRenderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null = null;
  private host: HTMLElement | undefined;
  private raf = 0;

  // Pushed in from the reactive graph. Plain fields — the loop just reads them.
  private plans: StrokePlan[] = [];
  private params: PencilParams | undefined;
  private view: PadView = { raw: true, filtered: true, cusps: true, dabs: true, fill: false };
  private recorder: PenRecorder | undefined;

  /** Frame time, ms — published back out by the component at ~4Hz, not per frame. */
  frameMs = 0;

  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "pad-canvas";
    // Without this a pen drag on an iPad is eaten by the browser as a scroll,
    // and no amount of preventDefault in a handler gets it back.
    this.canvas.style.touchAction = "none";
    this.ctx = this.canvas.getContext("2d");
  }

  /** Adopt into a host element. Idempotent — a re-render must not re-parent. */
  mount(host: HTMLElement): void {
    if (this.canvas.parentElement === host) {
      return;
    }
    this.host = host;
    host.append(this.canvas);
    this.resize();
    window.addEventListener("resize", this.onResize);
    if (this.raf === 0) {
      const tick = (): void => {
        const started = performance.now();
        this.draw();
        this.frameMs = performance.now() - started;
        this.raf = requestAnimationFrame(tick);
      };
      this.raf = requestAnimationFrame(tick);
    }
  }

  /**
   * Release from a host — but ONLY if that host is still ours. A hot swap mounts
   * the successor before disposing the predecessor, so a naive cleanup here would
   * tear out a canvas the new component has already adopted, and the app would
   * come back from a component edit with a blank pad. This guard is the whole
   * reason `unmount` takes the host it is releasing from.
   */
  unmount(host: HTMLElement): void {
    if (this.host !== host) {
      return; // someone else owns it now — leave it alone
    }
    window.removeEventListener("resize", this.onResize);
    if (this.raf !== 0) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    this.canvas.remove();
    this.host = undefined;
  }

  setPlans(plans: StrokePlan[]): void {
    this.plans = plans;
  }

  setParams(params: PencilParams): void {
    this.params = params;
  }

  setView(view: PadView): void {
    this.view = view;
  }

  setRecorder(recorder: PenRecorder): void {
    this.recorder = recorder;
  }

  private readonly onResize = (): void => this.resize();

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const width = this.canvas.clientWidth || 800;
    const height = this.canvas.clientHeight || 600;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
  }

  private draw(): void {
    const ctx = this.ctx;
    const params = this.params;
    if (ctx === null || params === undefined) {
      return;
    }
    if (this.canvas.clientWidth * (window.devicePixelRatio || 1) !== this.canvas.width) {
      this.resize(); // the pane was resized by a layout change, not a window resize
    }
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    for (const plan of this.plans) {
      this.drawPlan(ctx, plan, false);
    }

    // The in-flight stroke is planned HERE, every frame, from the recorder's own
    // plain array — it never crosses the reactive boundary. This is what keeps
    // the line under the pen instead of one graph-recompute behind it.
    const live = this.recorder?.live;
    if (live !== undefined && live.length > 0) {
      this.drawPlan(ctx, planStroke(live, params), true);
    }
  }

  private drawPlan(ctx: CanvasRenderingContext2D, plan: StrokePlan, live: boolean): void {
    const params = this.params;
    if (params === undefined) {
      return;
    }

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
