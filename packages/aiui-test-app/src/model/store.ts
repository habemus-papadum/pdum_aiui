/**
 * store.ts — the durable roots and the control surface.
 *
 * Everything here survives a hot edit. The genuinely durable, imperative
 * object is the {@link paper}: a `PencilSurface` from
 * `@habemus-papadum/aiui-pencil` the user draws mixture components on. A
 * finished stroke is immediately REPLACED by its best-fit ellipse: the
 * `onStrokeEnd` callback fits in board units, appends to {@link ellipses}
 * (the app's ground truth), and pops the ink — the drawn Gaussian lives on as
 * geometry, not pixels.
 *
 * Add new state HERE; add new dataflow over it in graph.ts.
 */
import { PencilSurface, SKETCH } from "@habemus-papadum/aiui-pencil";
import { control, scope } from "@habemus-papadum/aiui-viz";
import { type EllipseShape, fitStrokeEllipse, type Vec2 } from "./mixture2d";

/** The app's instance scope: ONE slug qualifying every control, durable,
 * cell, and action — and naming the graph key + agent toolkit. */
export const appScope = scope("testapp");

/** The board's fixed coordinate space (viewBox units). The drawing canvas,
 * every sample, every ellipse, and the hex grid all live in this space; the
 * canvas maps its CSS pixels onto it at stroke end. */
export const BOARD_W = 680;
export const BOARD_H = 460;

// ── the control surface ──────────────────────────────────────────────────────

/** How many points to draw from the mixture. */
export const sampleCount = control({
  scope: appScope,
  value: 8000,
  min: 1000,
  max: 50000,
  step: 1000,
});

/** Which backend runs the EM E-step: plain JavaScript on the worker thread,
 * or a WebGPU compute kernel (falls back to js when no adapter exists — the
 * fit panel reports which one actually computed). */
export const backend = control<"js" | "webgpu">({
  scope: appScope,
  value: "js",
  options: ["js", "webgpu"],
});

/** Whether this browser exposes WebGPU at all — the toggle's enablement. */
export const webgpuAvailable = typeof navigator !== "undefined" && "gpu" in navigator;

// ── durable state ────────────────────────────────────────────────────────────

/** PRNG seed behind the sample draw — bumped by the `reseed` action. */
export const seed = appScope.durableSignal<number>("seed", 20260803);

/** The drawn mixture components, in stroke order — the app's ground truth.
 * Board units. Every cell in the graph hangs off this list. */
export const ellipses = appScope.durableSignal<readonly EllipseShape[]>("ellipses", []);

// ── the instrument ───────────────────────────────────────────────────────────

/** Map stroke points from canvas CSS px into board units. */
export function toBoard(
  points: ReadonlyArray<{ x: number; y: number }>,
  cssW: number,
  cssH: number,
): Vec2[] {
  const sx = cssW > 0 ? BOARD_W / cssW : 1;
  const sy = cssH > 0 ? BOARD_H / cssH : 1;
  return points.map((p) => ({ x: p.x * sx, y: p.y * sy }));
}

/**
 * The drawing surface. Ink persists only as long as the stroke is in flight:
 * on pen-up the stroke is fitted ({@link fitStrokeEllipse}) and replaced by
 * its ellipse — a stroke too short or too thin to fit is simply ignored. The
 * board component re-parents the canvas into the stage and arms it.
 */
export const paper = appScope.durable(
  "paper",
  () =>
    new PencilSurface({
      className: "board-paper",
      params: () => ({ ...SKETCH, size: 3, color: "#7aa2ff" }),
      // Transparent: the hexbin chart shows through, ink floats on it.
      background: () => undefined,
      onStrokeEnd: (end) => {
        const { width, height } = paper.size();
        const fitted = fitStrokeEllipse(toBoard(end.points, width, height));
        if (fitted !== null) {
          ellipses.set((list) => [...list, fitted]);
        }
        // The stroke's job is done — it pops, and the ellipse stands in for it.
        paper.clearAnimated(0.4);
      },
    }),
);

/** The EM worker — durable: created once, adopted across hot edits. */
export const emWorker = (): Worker =>
  appScope.durable(
    "em-worker",
    () => new Worker(new URL("./em.worker.ts", import.meta.url), { type: "module" }),
  );
