/**
 * surface.ts — the three-tier raster surface. Where the design's one hard problem
 * gets solved.
 *
 * ## The problem
 *
 * A textured, pressure-and-tilt-driven, erasable instrument wants **pixels**.
 * Vanishing ink — the overlay's gesture fade, which people rely on — wants
 * **stroke identity**, and a stroke stamped into a bitmap has none: you cannot
 * fade it, you cannot lift it, and an eraser that ran over it has already
 * destroyed the evidence.
 *
 * ## The resolution
 *
 * The fade window is *finite*. Let that one fact size everything:
 *
 *   > A stroke stays an individual object until it falls past a horizon. Past it,
 *   > it is flattened into one bitmap and forgotten. **The fade window, the undo
 *   > depth, and the retention horizon are the same number.**
 *
 * ```text
 *   display  =  settled  ∘  retained[0..n]  ∘  live
 *               ────────    ──────────────     ──────
 *               one flat    bounded list of    the in-flight strokes, stamped
 *               bitmap;     bbox tiles, each   INCREMENTALLY into their own
 *               no identity keeping its dabs   buffer
 *                           AND a baked raster
 * ```
 *
 * Every frame is an **ordered replay**: blit `settled`, then each retained tile,
 * then the live strokes. Three things fall out, and each is a feature we wanted:
 *
 *  - **Erase is free, and undoable.** An eraser is just a stroke with
 *    `tool: "erase"`, blitted `destination-out`. Because the replay is ordered, an
 *    eraser at position *k* removes exactly what was drawn before it and leaves
 *    later strokes alone — the correct semantics, without punching holes in any
 *    stored layer, which is what keeps it undoable.
 *  - **Undo is free below the horizon.** Pop the stroke. Flattening is what makes
 *    an edit permanent.
 *  - **Fade keeps its whole curve.** Strokes inside the window still have their
 *    dabs, so they are RE-STAMPED under the warp style — including the width
 *    stretch, which no baked bitmap can do. Affordable because the fading set is
 *    bounded by definition.
 *
 * With `fadeSec > 0` strokes never reach `settled` at all: they are born, they
 * warp, they pop, they are discarded, and the surface costs nothing over time.
 * That is the overlay's gesture ink, exactly as it behaves today.
 *
 * ## Why it is also FASTER than the vector surface it replaced
 *
 * Retired `aiui-ink` cleared the canvas and re-stroked every stroke, every
 * frame: cost grew with the drawing, forever. Here the live stroke stamps only the dabs that
 * arrived since the last frame, and everything else is a `drawImage`. Going to
 * pixels is what buys that — and with `getCoalescedEvents` and
 * `getPredictedEvents` both absent in iPadOS Safari, incremental stamping is not
 * an optimisation, it is the whole latency budget.
 */

import { planStroke } from "./dabs";
import {
  crossfadeStyle,
  type FadeStyle,
  FULL_STYLE,
  fadeStyle,
  INK_HOLD,
  isFullStyle,
} from "./fade";
import type { Rect } from "./geom";
import { GrainCache } from "./grain";
import { clearLayer, growLayer, type Layer, makeLayer } from "./layer";
import type { PencilParams } from "./pencil";
import { applyGrain, boundsOfDabs, grainOf, stampDabs, styleKey, unstableTail } from "./stamp";
import {
  DEFAULT_RETENTION,
  type InkEvent,
  type InkState,
  type InkStroke,
  type LiveStroke,
  type PencilSurfaceOptions,
  type StrokeEnd,
  type StrokeRecord,
  type Tool,
} from "./stroke-types";
import { type PenSample, penSample } from "./telemetry";

// Re-exported so every `from "./surface"` import site and the package barrel
// keep resolving the public data-face types unchanged.
export type { InkEvent, InkState, InkStroke, PencilSurfaceOptions, StrokeEnd, Tool };

export class PencilSurface {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly opts: PencilSurfaceOptions;
  private readonly target: HTMLElement;
  private readonly grain = new GrainCache();

  /** The flat bitmap of everything past the horizon. Created on first flatten. */
  private settled: Layer | undefined;
  /** Completed strokes, oldest first. Bounded by `retention`. */
  private retained: StrokeRecord[] = [];
  private live = new Map<string, LiveStroke>();
  /**
   * Strokes pushed past the undo horizon into `settled`: still visible, still
   * part of the drawing's DATA, no longer individually addressable as pixels.
   * Unbounded until `clear()` — raw points, a few KB per stroke; the fade modes
   * never flatten, so this only grows on a permanent canvas.
   */
  private flattened: (InkStroke & { params: PencilParams })[] = [];
  private listeners = new Set<(event: InkEvent) => void>();
  private localId: string | undefined;
  /** Reused each frame to composite a live stroke's stable prefix + unstable tail. */
  private scratch: Layer | undefined;

  private seq = 0;
  private raf = 0;
  /** An animated clear in flight: every stroke rides the pop, then a real clear. */
  private clearing: { startedAt: number; fadeMs: number } | undefined;
  private dirty = true;
  private cssWidth = 0;
  private cssHeight = 0;
  private readonly onResize = () => this.resize();
  private ro: ResizeObserver | undefined;

  constructor(opts: PencilSurfaceOptions) {
    this.opts = opts;
    this.target = opts.target ?? document.body;
    this.canvas = document.createElement("canvas");
    this.canvas.className = opts.className ?? "aiui-pencil";
    Object.assign(this.canvas.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
      pointerEvents: "none",
      // Essential on touch devices: without it the browser eats pen drags as
      // scroll, and no handler can get them back.
      touchAction: "none",
    } satisfies Partial<CSSStyleDeclaration>);
    this.ctx = this.canvas.getContext("2d");
    this.target.append(this.canvas);
    this.resize();
    window.addEventListener("resize", this.onResize);
    // The TARGET's size is the coordinate truth, and it can change without a
    // window resize — the remote client's plane div re-fits on every VIDEO
    // resize (WebRTC ramps resolution; aspect changes on a tab switch). Found
    // live (2026-07-17): the preview surface kept its creation-time system
    // (the plane had no size yet, so the window fallback), its canvas was
    // CSS-stretched into the real plane, and preview ink landed scaled by the
    // difference — the further the stage's aspect from the video's, the
    // farther the preview from where the echoed stroke would land. Observe the
    // canvas itself; guard so an unchanged layout tick never clears the paper.
    if (typeof ResizeObserver === "function") {
      this.ro = new ResizeObserver(() => {
        const w = this.canvas.clientWidth || window.innerWidth;
        const h = this.canvas.clientHeight || window.innerHeight;
        if (w !== this.cssWidth || h !== this.cssHeight) {
          this.resize();
        }
      });
      this.ro.observe(this.canvas);
    }

    if (opts.localInput ?? true) {
      this.bindLocalInput();
    }
    if (this.ctx !== null && typeof requestAnimationFrame === "function") {
      const tick = (): void => {
        this.draw();
        this.raf = requestAnimationFrame(tick);
      };
      this.raf = requestAnimationFrame(tick);
    }
  }

  // ── public surface (shape kept from retired aiui-ink's InkSurface) ──────────

  setActive(on: boolean): void {
    // A surface with no local input never owns the pointer: its canvas exists to
    // SHOW ink (a preview, a remote-markup overlay), and pointer-events: auto
    // would only block the page beneath it. Which is exactly what happened once:
    // the Lab's tab-mode overlay — full-viewport, z-index 2000 — was setActive'd
    // out of habit and swallowed every click on the page. There were no
    // listeners to arm; the only effect was the blocking.
    if (this.opts.localInput === false) {
      return;
    }
    this.canvas.style.pointerEvents = on ? "auto" : "none";
  }

  size(): { width: number; height: number } {
    return { width: this.cssWidth, height: this.cssHeight };
  }

  hasInk(): boolean {
    return this.retained.length > 0 || this.settled !== undefined || this.live.size > 0;
  }

  /** Completed strokes still individually addressable (i.e. still undoable). */
  strokeCount(): number {
    return this.retained.length;
  }

  inkBounds(): Rect | undefined {
    const boxes = this.retained
      .map((r) => boundsOfDabs(r.dabs))
      .filter((b): b is Rect => b !== undefined);
    if (boxes.length === 0) {
      return undefined;
    }
    return boxes.reduce((a, b) => ({
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      w: Math.max(a.x + a.w, b.x + b.w) - Math.min(a.x, b.x),
      h: Math.max(a.y + a.h, b.y + b.h) - Math.min(a.y, b.y),
    }));
  }

  /**
   * Force the next frame to redraw, even though nothing changed.
   *
   * Exists for one consumer: a `captureStream()` of this canvas. The stream
   * emits a frame only when the canvas REPAINTS, and this surface deliberately
   * paints nothing when still ("free battery on an iPad") — so a viewer joining
   * a quiet host would stare at a stream that has never produced a frame. The
   * host keeps the stream warm by calling this on a slow tick while anyone is
   * watching; the cost is a few `drawImage` calls per tick.
   */
  repaint(): void {
    this.dirty = true;
  }

  /**
   * Watch the drawing change. `"strokes"` fires at human rate (commit, undo,
   * clear, fade-out); `"live"` fires per pointer batch — 60–120 Hz while the pen
   * moves. The events carry nothing: read {@link ink} when you care, so a
   * throttled subscriber pays for snapshots at ITS rate, not the pen's.
   */
  subscribe(listener: (event: InkEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * The drawing, as data: committed strokes (including those flattened past the
   * undo horizon — still part of the picture) plus the strokes in flight with
   * every point captured so far. Fresh arrays each call, so reference equality
   * means "actually changed"; committed point arrays are shared (they never
   * mutate), live ones are copied (they do).
   */
  ink(): InkState {
    const strokes: InkStroke[] = [
      ...this.flattened.map(({ id, tool, points, bornAt }) => ({ id, tool, points, bornAt })),
      ...this.retained.map((r) => ({
        id: r.id,
        tool: r.tool,
        points: r.points as readonly PenSample[],
        bornAt: r.bornAt,
      })),
    ];
    const live: InkStroke[] = [...this.live.values()].map((stroke) => ({
      id: stroke.id,
      tool: stroke.tool,
      points: stroke.samples.slice(),
      bornAt: stroke.bornAt,
    }));
    return { strokes, live };
  }

  /**
   * The instrument as currently configured — so a downstream consumer can run
   * the widget's own pipeline (`planStroke(stroke.points, surface.params())`)
   * or substitute parameters of its own. The math itself is exported from the
   * package root: `planStroke`, `densify`, `detectCusps`, `PointFilter`.
   */
  params(): PencilParams {
    return this.opts.params();
  }

  /**
   * Undo the most recent retained stroke. Returns false when there is nothing
   * left to undo — because the horizon has been crossed and the stroke is now
   * part of `settled`, which is exactly what flattening MEANS. Undo depth and the
   * retention horizon are the same number by construction, not by coincidence.
   */
  undo(): boolean {
    const popped = this.retained.pop();
    if (popped === undefined) {
      return false;
    }
    this.dirty = true;
    this.emit("strokes");
    return true;
  }

  clear(auto = false): void {
    const had = this.hasInk();
    this.retained = [];
    this.flattened = [];
    this.settled = undefined;
    this.live.clear();
    this.localId = undefined;
    this.clearing = undefined;
    this.dirty = true;
    if (had && auto) {
      this.opts.onAutoClear?.();
    }
    this.emit("strokes");
    this.emit("live");
  }

  /**
   * Send every COMPLETED stroke into the TAIL of the vanishing curve — the
   * charge-and-pop — so previous marks animate OUT rather than snapping off,
   * while leaving the stroke still under the pen untouched.
   *
   * This is the "one mark at a time" primitive. {@link PencilSurfaceOptions.onStrokeStart}
   * fires from inside `beginStroke`, *after* the new stroke has joined the
   * `live` set, so — like a plain {@link clearAnimated} — touching `live` here
   * would wipe the mark just begun; this re-times only the *completed* strokes.
   * Each is advanced to the hold→pop boundary of the AMBIENT fade window
   * (`fadeSec`) and left to pop on the normal per-frame fade, so starting a new
   * stroke triggers the previous one's dissolve exactly as if its clock had run
   * out. A stroke already in its tail is not re-charged (min keeps the earlier
   * clock). With no fade window (`fadeSec` 0) there is nothing to animate
   * against, so the completed strokes are dropped at once.
   */
  popCompleted(): void {
    const fadeMs = this.fadeMs();
    if (fadeMs <= 0) {
      const had =
        this.retained.length > 0 || this.flattened.length > 0 || this.settled !== undefined;
      this.retained = [];
      this.flattened = [];
      this.settled = undefined;
      if (had) {
        this.dirty = true;
        this.emit("strokes");
      }
      return;
    }
    const now = this.now();
    // The bornAt whose age is exactly the hold→pop boundary. Advancing a
    // younger stroke to it drops it into the charge-and-pop; a stroke already
    // past it keeps its (earlier) clock, so it is never re-charged mid-pop.
    const boundary = now - INK_HOLD * fadeMs;
    for (const record of this.retained) {
      record.bornAt = Math.min(record.bornAt, boundary);
    }
    // Flattened points and the settled bitmap have no dabs to warp (and with
    // fade active are always empty) — drop them so nothing outlives the pop.
    this.flattened = [];
    this.settled = undefined;
    this.dirty = true;
  }

  /**
   * Clear, but let the ink go the way vanishing ink goes: every stroke jumps to
   * the **charge-and-pop tail** of the fade curve — it thickens, heats, and pops,
   * over `durationSec` — and then the surface is really cleared. The same curve a
   * fading stroke rides; an animated clear is just all of them riding it at once.
   *
   * This is also D4's retire mechanism: an overlay whose viewport scrolled or
   * reflowed calls this, and the disappearance reads as intentional rather than
   * as a glitch. Strokes already flattened past the horizon have no dabs left to
   * warp, so `settled` alpha-fades as a layer on the same clock — an honest
   * degradation, and one the overlay never sees (with fade active nothing ever
   * reaches `settled`).
   */
  clearAnimated(durationSec = 0.5): void {
    if (!this.hasInk()) {
      return;
    }
    // `durationSec` is the VISIBLE part. The curve idles for INK_HOLD of its
    // life, so the synthetic window is longer, and every stroke is re-timed to
    // sit exactly at the hold boundary right now.
    const now = this.now();
    const fadeMs = (durationSec * 1000) / (1 - INK_HOLD);
    for (const record of this.retained) {
      record.bornAt = now - INK_HOLD * fadeMs;
    }
    this.live.clear();
    this.localId = undefined;
    this.clearing = { startedAt: now, fadeMs };
    this.dirty = true;
    this.emit("live");
  }

  /**
   * Restart every stroke's fade clock. Turning vanishing ink ON is why this
   * exists: `bornAt` is pen-up time, so ink that sat on a permanent canvas for
   * minutes is already older than any fade window, and flipping the switch would
   * blink the whole drawing out in a single frame.
   */
  restartFade(): void {
    const now = this.now();
    for (const record of this.retained) {
      record.bornAt = now;
    }
    this.dirty = true;
  }

  // ── the remote pen (an iPad, over the pencil wire) ──────────────────────────

  remoteBegin(id: string, init: { tool: Tool; params: PencilParams; point: PenSample }): void {
    this.beginStroke(id, init.tool, init.params, init.point, undefined);
  }

  remotePoint(id: string, point: PenSample): void {
    const stroke = this.live.get(id);
    if (stroke !== undefined) {
      stroke.samples.push(point);
      this.dirty = true;
      this.emit("live");
    }
  }

  remoteEnd(id: string, point?: PenSample): void {
    const stroke = this.live.get(id);
    if (stroke === undefined) {
      return;
    }
    if (point !== undefined) {
      stroke.samples.push(point);
    }
    this.commit(stroke, true);
  }

  remoteCancel(id: string): void {
    this.live.delete(id);
    this.dirty = true;
    this.emit("live");
  }

  dispose(): void {
    if (this.raf !== 0 && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this.raf);
    }
    window.removeEventListener("resize", this.onResize);
    this.ro?.disconnect();
    this.canvas.remove();
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private now(): number {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
  }

  private dpr(): number {
    return window.devicePixelRatio || 1;
  }

  private fadeMs(): number {
    return (this.opts.fadeSec?.() ?? 0) * 1000;
  }

  private emit(event: InkEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private beginStroke(
    id: string,
    tool: Tool,
    params: PencilParams,
    first: PenSample,
    pointerId: number | undefined,
  ): void {
    this.live.set(id, {
      id,
      tool,
      params,
      bornAt: this.now(),
      samples: [first],
      dabs: [],
      wet: undefined,
      stamped: 0,
      pointerId,
    });
    this.dirty = true;
    this.opts.onStrokeStart?.(id, tool);
    this.emit("live");
  }

  /** Pen-up: bake the wet buffer into a retained tile. */
  private commit(stroke: LiveStroke, remote: boolean): void {
    this.live.delete(stroke.id);
    this.dirty = true;
    this.emit("live"); // the stroke left the live set, whatever happens next

    if (stroke.samples.length < (this.opts.minCommitPoints ?? 1)) {
      return; // a tap below the floor: not ink
    }
    const plan = planStroke(stroke.samples, stroke.params);
    const bounds = boundsOfDabs(plan.dabs);
    if (bounds === undefined) {
      return;
    }

    // Finish the bake: stamp whatever the tail was still withholding, then grain
    // ONCE over the whole accumulated coverage. The wet buffer thereby *becomes*
    // the retained tile — no copy, no re-render, and no pop, because these are
    // literally the pixels that were on screen a frame ago.
    let wet = stroke.wet ?? makeLayer(bounds, this.dpr());
    wet = growLayer(wet, bounds, this.dpr());
    stampDabs(
      wet,
      plan.dabs,
      stroke.stamped,
      plan.dabs.length,
      stroke.params.color,
      FULL_STYLE,
      stroke.tool,
    );
    applyGrain(wet, this.grain, grainOf(stroke.tool, stroke.params), stroke.params.grainScale);

    const record: StrokeRecord = {
      id: stroke.id,
      tool: stroke.tool,
      params: stroke.params,
      dabs: plan.dabs,
      points: stroke.samples,
      bornAt: this.now(),
      tile: wet,
      tileKey: "full",
    };
    this.retained.push(record);
    this.flattenPastHorizon();
    this.emit("strokes");

    const end: StrokeEnd = {
      id: stroke.id,
      tool: stroke.tool,
      points: stroke.samples,
      bounds,
    };
    if (remote) {
      this.opts.onRemoteStrokeEnd?.(end);
    } else {
      this.opts.onStrokeEnd?.(end);
    }
  }

  /**
   * Push the oldest strokes into `settled` once they fall past the horizon.
   *
   * Only in PERMANENT mode. With vanishing ink on, strokes die inside the window
   * and never reach the horizon at all — so `settled` stays empty, and the surface
   * costs nothing no matter how long you draw. Two modes, one mechanism.
   */
  private flattenPastHorizon(): void {
    if (this.fadeMs() > 0) {
      return;
    }
    const horizon = this.opts.retention?.() ?? DEFAULT_RETENTION;
    while (this.retained.length > horizon) {
      const oldest = this.retained.shift();
      if (oldest === undefined) {
        continue;
      }
      // The PIXELS lose their identity here; the DATA does not. The stroke list
      // (ink()) still reports it — same strokes, same order — so no emit.
      this.flattened.push({
        id: oldest.id,
        tool: oldest.tool,
        points: oldest.points,
        bornAt: oldest.bornAt,
        params: oldest.params,
      });
      if (oldest.tile === undefined) {
        continue;
      }
      if (this.settled === undefined) {
        this.settled = makeLayer({ x: 0, y: 0, w: this.cssWidth, h: this.cssHeight }, this.dpr());
      }
      const ctx = this.settled.ctx;
      ctx.save();
      ctx.globalCompositeOperation = oldest.tool === "erase" ? "destination-out" : "source-over";
      ctx.drawImage(
        oldest.tile.canvas,
        oldest.tile.ox,
        oldest.tile.oy,
        oldest.tile.w,
        oldest.tile.h,
      );
      ctx.restore();
    }
  }

  /** The tile for a retained stroke under a warp style, re-baking when it moves. */
  private tileFor(record: StrokeRecord, style: FadeStyle): Layer | undefined {
    const key = isFullStyle(style) ? "full" : styleKey(style);
    if (record.tile !== undefined && record.tileKey === key) {
      return record.tile;
    }
    // The stretch is why this cannot be a scaled blit of the baked tile: warping
    // thickens the LINE, and scaling a raster moves the geometry. Re-stamp.
    const bounds = boundsOfDabs(record.dabs, style.widthScale);
    if (bounds === undefined) {
      return undefined;
    }
    const layer = makeLayer(bounds, this.dpr());
    stampDabs(layer, record.dabs, 0, record.dabs.length, record.params.color, style, record.tool);
    applyGrain(layer, this.grain, grainOf(record.tool, record.params), record.params.grainScale);
    record.tile = layer;
    record.tileKey = key;
    return layer;
  }

  private blit(layer: Layer, tool: Tool, alpha: number): void {
    const ctx = this.ctx;
    if (ctx === null) {
      return;
    }
    ctx.save();
    // An eraser at position k removes exactly what was drawn BEFORE it — settled
    // and every earlier retained stroke — and leaves later ones alone. That is
    // the correct semantics, and it is a property of the replay order, not of
    // anything stored.
    ctx.globalCompositeOperation = tool === "erase" ? "destination-out" : "source-over";
    ctx.globalAlpha = alpha;
    ctx.drawImage(layer.canvas, layer.ox, layer.oy, layer.w, layer.h);
    ctx.restore();
  }

  /**
   * Composite one live stroke: the baked stable prefix plus the not-yet-stable
   * tail, grained together in a scratch so it matches the tile it will become.
   */
  private drawLive(stroke: LiveStroke): void {
    const plan = planStroke(stroke.samples, stroke.params);
    stroke.dabs = plan.dabs;
    if (plan.dabs.length === 0) {
      return;
    }
    const dpr = this.dpr();
    const tail = unstableTail(stroke.params);
    const stable = Math.max(0, plan.dabs.length - tail);

    // Bake the newly-stable dabs — and ONLY those. This is the incremental
    // stamping the whole latency budget rests on: a stroke of 6,000 dabs costs
    // the same per frame as one of 60.
    if (stable > stroke.stamped) {
      const region = boundsOfDabs(plan.dabs.slice(stroke.stamped, stable));
      if (region !== undefined) {
        stroke.wet =
          stroke.wet === undefined ? makeLayer(region, dpr) : growLayer(stroke.wet, region, dpr);
        stampDabs(
          stroke.wet,
          plan.dabs,
          stroke.stamped,
          stable,
          stroke.params.color,
          FULL_STYLE,
          stroke.tool,
        );
        stroke.stamped = stable;
      }
    }

    const full = boundsOfDabs(plan.dabs);
    if (full === undefined) {
      return;
    }
    this.scratch =
      this.scratch === undefined ? makeLayer(full, dpr) : growLayer(this.scratch, full, dpr);
    const scratch = this.scratch;
    clearLayer(scratch);

    if (stroke.wet !== undefined) {
      scratch.ctx.drawImage(
        stroke.wet.canvas,
        stroke.wet.ox - scratch.ox,
        stroke.wet.oy - scratch.oy,
        stroke.wet.w,
        stroke.wet.h,
      );
    }
    stampDabs(
      scratch,
      plan.dabs,
      stroke.stamped,
      plan.dabs.length,
      stroke.params.color,
      FULL_STYLE,
      stroke.tool,
    );
    applyGrain(scratch, this.grain, grainOf(stroke.tool, stroke.params), stroke.params.grainScale);
    this.blit(scratch, stroke.tool, 1);
  }

  private resize(): void {
    const dpr = this.dpr();
    const oldW = this.cssWidth;
    const oldH = this.cssHeight;
    this.cssWidth = this.canvas.clientWidth || window.innerWidth;
    this.cssHeight = this.canvas.clientHeight || window.innerHeight;
    this.canvas.width = Math.round(this.cssWidth * dpr);
    this.canvas.height = Math.round(this.cssHeight * dpr);
    this.dirty = true;

    if (
      this.opts.resize === "rescale" &&
      oldW > 0 &&
      oldH > 0 &&
      (this.cssWidth !== oldW || this.cssHeight !== oldH)
    ) {
      this.rescale(this.cssWidth / oldW, this.cssHeight / oldH);
    }
  }

  /**
   * Re-bake the whole drawing at a new scale — D4's scratchpad half. Nothing
   * reflows inside a canvas, and every stroke's raw points are still here, so
   * the drawing genuinely rescales: positions by (sx, sy), stroke width by the
   * geometric mean, each stroke under its OWN brush. Strokes past the horizon
   * come back addressable, which is a resize bonus, not a bug.
   */
  private rescale(sx: number, sy: number): void {
    // Fresh fade clocks (keepAge false): a resize re-times ink like it always
    // has — old ink under a fade window must not blink out with the reflow.
    this.rebuild((pt) => ({ ...pt, x: pt.x * sx, y: pt.y * sy }), Math.sqrt(sx * sy), false);
  }

  /**
   * Translate every stroke by (dx, dy) CSS px — the document-anchored
   * overlay's REBASE (owner, 2026-07-17). Stroke tiles are bounds-local, so
   * ink translated past the canvas edge keeps its points AND its pixels and
   * re-bakes back into view on a later translate: the overlay's window slides
   * over an unbounded drawing, viewport-sized memory for the visible raster.
   * `settled` (raster past the points horizon) cannot move and is dropped —
   * rescale's same honest degradation; fade-active surfaces never grow one.
   * Fade clocks are PRESERVED (a rebase is bookkeeping, not new ink).
   */
  translate(dx: number, dy: number): void {
    if (dx === 0 && dy === 0) {
      return;
    }
    this.rebuild((pt) => ({ ...pt, x: pt.x + dx, y: pt.y + dy }), 1, true);
  }

  /** The shared re-bake under {@link rescale} and {@link translate}: every
   * stroke re-begun from its raw points through `map`, each under its own
   * brush (sized by `sizeScale`); live strokes shift in place and re-stamp. */
  private rebuild(map: (pt: PenSample) => PenSample, sizeScale: number, keepAge: boolean): void {
    const strokes = [
      ...this.flattened.map((f) => ({
        tool: f.tool,
        points: f.points,
        params: f.params,
        bornAt: f.bornAt,
      })),
      ...this.retained.map((r) => ({
        tool: r.tool,
        points: r.points,
        params: r.params,
        bornAt: r.bornAt,
      })),
    ];
    const liveStrokes = [...this.live.values()];

    this.retained = [];
    this.flattened = [];
    this.settled = undefined;
    this.live.clear();

    for (const stroke of strokes) {
      const params =
        sizeScale === 1
          ? stroke.params
          : { ...stroke.params, size: stroke.params.size * sizeScale };
      const mapped = stroke.points.map(map);
      const id = `rebuild-${this.seq++}`;
      this.beginStroke(id, stroke.tool, params, mapped[0], undefined);
      const live = this.live.get(id);
      if (live !== undefined) {
        live.samples.push(...mapped.slice(1));
        this.commit(live, true);
        if (keepAge) {
          const record = this.retained[this.retained.length - 1];
          if (record !== undefined && record.id === id) {
            record.bornAt = stroke.bornAt;
          }
        }
      }
    }

    // A stroke under the pen mid-rebuild maps in place; its wet buffer is at
    // the old geometry, so it re-stamps from zero next frame.
    for (const stroke of liveStrokes) {
      if (sizeScale !== 1) {
        stroke.params = { ...stroke.params, size: stroke.params.size * sizeScale };
      }
      for (let i = 0; i < stroke.samples.length; i++) {
        stroke.samples[i] = map(stroke.samples[i]);
      }
      stroke.wet = undefined;
      stroke.stamped = 0;
      this.live.set(stroke.id, stroke);
    }

    this.dirty = true;
    this.emit("strokes");
    this.emit("live");
  }

  private draw(): void {
    const ctx = this.ctx;
    if (ctx === null) {
      return;
    }
    // BOTH axes, deliberately: this used to check width alone, and a canvas whose
    // container changed height-only (the remote client's plane, shrinking when the
    // video's letterbox arrives) kept its tall backing store while CSS squeezed it
    // — every preview stroke rendered at y × (displayHeight / backingHeight),
    // dead-on at the top of the canvas and further off the lower you drew.
    const dpr = this.dpr();
    if (
      (this.canvas.clientWidth > 0 &&
        Math.round(this.canvas.clientWidth * dpr) !== this.canvas.width) ||
      (this.canvas.clientHeight > 0 &&
        Math.round(this.canvas.clientHeight * dpr) !== this.canvas.height)
    ) {
      this.resize();
    }
    // An animated clear overrides the fade clock: every stroke is on ITS window.
    const fadeMs = this.clearing?.fadeMs ?? this.fadeMs();
    const fading = (fadeMs > 0 && this.retained.length > 0) || this.clearing !== undefined;
    if (!this.dirty && !fading && this.live.size === 0) {
      return; // a still drawing draws nothing. Free battery on an iPad.
    }
    this.dirty = false;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    if (this.settled !== undefined) {
      // Flattened pixels have no dabs to warp, so under an animated clear the
      // settled layer rides the same clock alpha-only: opaque through the
      // charge, gone at the pop.
      const settledAlpha =
        this.clearing === undefined
          ? 1
          : fadeStyle(
              this.now() - this.clearing.startedAt + INK_HOLD * this.clearing.fadeMs,
              this.clearing.fadeMs,
            ).alpha;
      if (settledAlpha > 0) {
        this.blit(this.settled, "draw", settledAlpha);
      }
    }

    const now = this.now();
    // An animated clear is always the warp — announcing the death is its point.
    const curve = this.clearing ? "warp" : (this.opts.fadeCurve?.() ?? "warp");
    const survivors: StrokeRecord[] = [];
    for (const record of this.retained) {
      const style =
        curve === "crossfade"
          ? crossfadeStyle(now - record.bornAt, fadeMs)
          : fadeStyle(now - record.bornAt, fadeMs);
      if (style.alpha <= 0) {
        continue; // popped out of existence
      }
      survivors.push(record);
      const tile = this.tileFor(record, style);
      if (tile !== undefined) {
        this.blit(tile, record.tool, style.alpha);
      }
    }
    const expired = this.retained.length - survivors.length;
    this.retained = survivors;
    if (expired > 0) {
      this.emit("strokes"); // strokes faded out of the picture, not just off it
    }

    for (const stroke of this.live.values()) {
      this.drawLive(stroke);
    }

    const background = this.opts.background?.();
    if (background !== undefined) {
      // Painted LAST, composited UNDER (destination-over fills only where alpha
      // is short of 1): the replay stays a transparent-layer algebra — an eraser
      // still truly erases ink — and the paper shows through the holes.
      ctx.save();
      ctx.globalCompositeOperation = "destination-over";
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);
      ctx.restore();
    }

    if (this.clearing !== undefined) {
      const done = this.now() - this.clearing.startedAt >= (1 - INK_HOLD) * this.clearing.fadeMs;
      if (done && this.retained.length === 0) {
        this.clear(); // user-initiated: no onAutoClear
      } else {
        this.dirty = true; // keep the animation's frames coming
      }
      return;
    }
    if (expired > 0 && this.retained.length === 0 && this.live.size === 0) {
      this.clear(true);
    }
  }

  private localPoint(e: PointerEvent): PenSample {
    const rect = this.canvas.getBoundingClientRect();
    const s = penSample(e);
    return { ...s, x: s.x - rect.left, y: s.y - rect.top };
  }

  private bindLocalInput(): void {
    this.canvas.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) {
        return;
      }
      if (this.opts.shouldCapture !== undefined && !this.opts.shouldCapture(e)) {
        return;
      }
      try {
        this.canvas.setPointerCapture(e.pointerId);
      } catch {
        // Synthetic pointers have no capturable id; inking works anyway.
      }
      const id = `local-${this.seq++}`;
      this.localId = id;
      this.beginStroke(
        id,
        this.opts.tool?.() ?? "draw",
        this.opts.params(),
        this.localPoint(e),
        e.pointerId,
      );
    });

    this.canvas.addEventListener("pointermove", (e) => {
      const id = this.localId;
      if (id === undefined) {
        return;
      }
      const stroke = this.live.get(id);
      if (stroke === undefined || stroke.pointerId !== e.pointerId) {
        return;
      }
      for (const raw of coalesced(e)) {
        stroke.samples.push(this.localPoint(raw));
      }
      this.dirty = true;
      this.emit("live");
    });

    const finish = (e: PointerEvent): void => {
      const id = this.localId;
      if (id === undefined) {
        return;
      }
      const stroke = this.live.get(id);
      if (stroke === undefined || stroke.pointerId !== e.pointerId) {
        return;
      }
      this.localId = undefined;
      this.commit(stroke, false);
    };
    this.canvas.addEventListener("pointerup", finish);
    this.canvas.addEventListener("pointercancel", finish);
  }
}

/**
 * The high-frequency samples a pen emits between animation frames — where the
 * signal lives, on the browsers that offer it. iPadOS Safari does not (measured,
 * July 2026), so there it falls back to the single event and the pipeline's
 * spline does the reconstructing instead.
 */
function coalesced(e: PointerEvent): PointerEvent[] {
  const fn = (e as PointerEvent & { getCoalescedEvents?: () => PointerEvent[] }).getCoalescedEvents;
  if (typeof fn === "function") {
    const events = fn.call(e);
    if (events.length > 0) {
      return events;
    }
  }
  return [e];
}
