/**
 * center-ghost.ts — the Zen guide's focus point. An imperative rAF canvas
 * island (playbook: animation loops never touch the reactive graph) that, while
 * armed, samples the best-fit CIRCLE CENTRE of the live stroke every frame and
 * draws it as a short **ghosting trail** — recent centres glow and the older
 * ones drop off within {@link TRAIL_MS}.
 *
 * Why its own renderer and not the pencil: the pencil's vanishing ink is a
 * whole textured stroke pipeline on a fade curve; this is one soft dot with a
 * comet tail, drawn as plainly as possible. Early in a stroke the fitted centre
 * jumps around as points accumulate; as the loop closes it settles to a still
 * point — which is the thing to focus on. That focus is the exercise (a
 * calligraphy-style "find the centre" drill), so the guide shows the centre and
 * NOTHING else until the stroke is lifted and the full fit is revealed.
 */

import { fitCircle, type Vec } from "./circle";

/** How long a centre sample lingers before it fades out, ms. */
export const TRAIL_MS = 250;
/** Hard cap on retained samples (≈ TRAIL_MS × 60 Hz, with headroom). */
const MAX_TRAIL = 64;

interface Ghost {
  x: number;
  y: number;
  t: number;
}

export class CenterGhost {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly source: () => readonly Vec[];
  private trail: Ghost[] = [];
  private raf = 0;
  private armed = false;
  private cssW = 0;
  private cssH = 0;

  constructor(opts: { source: () => readonly Vec[]; className?: string }) {
    this.source = opts.source;
    this.canvas = document.createElement("canvas");
    this.canvas.className = opts.className ?? "center-ghost";
    Object.assign(this.canvas.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
      pointerEvents: "none",
    } satisfies Partial<CSSStyleDeclaration>);
    this.ctx = this.canvas.getContext("2d");
    if (typeof requestAnimationFrame === "function") {
      const tick = (): void => {
        this.frame();
        this.raf = requestAnimationFrame(tick);
      };
      this.raf = requestAnimationFrame(tick);
    }
  }

  /** Begin tracking the live centre (Zen mode, pen down). Starts a fresh trail. */
  arm(): void {
    this.armed = true;
    this.trail = [];
  }

  /** Stop and wipe — pen up (the full fit takes over) or a mode change. */
  disarm(): void {
    this.armed = false;
    this.trail = [];
    this.clear();
  }

  dispose(): void {
    if (this.raf !== 0 && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this.raf);
    }
    this.canvas.remove();
  }

  private now(): number {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
  }

  private dpr(): number {
    return window.devicePixelRatio || 1;
  }

  private clear(): void {
    if (this.ctx === null) {
      return;
    }
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private resize(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === this.cssW && h === this.cssH) {
      return;
    }
    this.cssW = w;
    this.cssH = h;
    const dpr = this.dpr();
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
  }

  private frame(): void {
    const ctx = this.ctx;
    if (ctx === null) {
      return;
    }
    this.resize();
    if (!this.armed) {
      return; // disarm() already cleared; a still canvas costs nothing
    }
    const now = this.now();

    // Sample the current best-fit centre and append it to the trail.
    const points = this.source();
    const fit = points.length >= 3 ? fitCircle(points) : null;
    if (fit !== null) {
      this.trail.push({ x: fit.cx, y: fit.cy, t: now });
      if (this.trail.length > MAX_TRAIL) {
        this.trail.shift();
      }
    }
    // Age out the tail.
    this.trail = this.trail.filter((g) => now - g.t <= TRAIL_MS);

    const dpr = this.dpr();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    ctx.save();
    // Oldest first so the freshest sits on top.
    for (const g of this.trail) {
      const life = Math.max(0, 1 - (now - g.t) / TRAIL_MS); // 1 = new, 0 = gone
      const radius = 2 + 4 * life;
      ctx.beginPath();
      ctx.fillStyle = `rgba(178, 200, 255, ${0.45 * life})`;
      ctx.shadowColor = "rgba(150, 185, 255, 0.9)";
      ctx.shadowBlur = 12 * life;
      ctx.arc(g.x, g.y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    // The current focus point, brightest and unfaded.
    const head = this.trail[this.trail.length - 1];
    if (head !== undefined) {
      ctx.beginPath();
      ctx.fillStyle = "rgba(224, 233, 255, 0.95)";
      ctx.shadowColor = "rgba(180, 205, 255, 1)";
      ctx.shadowBlur = 16;
      ctx.arc(head.x, head.y, 4.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}
