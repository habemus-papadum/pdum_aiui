/**
 * graph.ts — the cell graph of the gratings notebook (playbook layer 2,
 * disposable side), plus the agent surface.
 *
 * Two kinds of cells here:
 *  - **map cells** stream a 2-D field map from the worker (one durable worker,
 *    jobs superseded by cancellation — drag λ and watch the half-finished map
 *    abandon itself). Each yields accumulator snapshots as chunks land.
 *  - **inline cells** are cheap pure computations (far fields, phasor arrows,
 *    screen profiles, readout formulas) — they run on the main thread.
 *
 * Every dependency arrives through the deps bundle — nothing is read inside
 * compute after an await (the out-of-sync rule); graph.test.ts probes each.
 */
import {
  applyTransmission,
  createMapAccumulator,
  type FieldMapData,
  farField,
  intensity,
  type MapReplyChunk,
  type MapRequest,
  sourceAt,
  sourcesOnGrid,
} from "@habemus-papadum/aiui-optics";
import {
  action,
  agentToolkit,
  cell,
  hotCellGraph,
  registerStandardTools,
  workerStream,
} from "@habemus-papadum/aiui-viz";
import {
  FILM,
  gratingOrders,
  imagingRequest,
  imagingWhiteRequest,
  lensImage,
  resolvingPower,
  SCREEN_Z,
  SPECTRO_LAMBDAS,
  sculptRequest,
  slitBenchRequest,
  slitMask,
  spectrometerRequest,
  tintFor,
  twoSourceRequest,
  twoSources,
  zoneFocalAt,
} from "./bench";
import {
  appScope,
  incidentDeg,
  lambda,
  nSlits,
  objDist,
  objX,
  pitch,
  probeX,
  probeZ,
  srcSep,
  whiteLight,
  zoneF,
} from "./store";

// --- the one durable map worker (jobs stream; supersession cancels) -----------

// Map cells hold (deps → undefined) where Workers don't exist — jsdom tests
// and SSR probe the inline cells; the maps are browser-only by nature.
const canWorker = typeof Worker !== "undefined";

const mapWorker = (): Worker =>
  appScope.durable(
    "mapWorker",
    () => new Worker(new URL("./map.worker.ts", import.meta.url), { type: "module" }),
  );

/** Streamed map compute: fold worker chunks through the accumulator, yielding
 *  a fresh snapshot per chunk (same buffers, new identity). Typed explicitly
 *  so every map cell infers Cell<FieldMapData> (an inline arrow would take
 *  its types FROM cell() and collapse to unknown). */
async function* mapCompute(
  deps: { req: MapRequest },
  ctx: { signal: AbortSignal; progress?: (f: number) => void },
): AsyncGenerator<FieldMapData, void, void> {
  const acc = createMapAccumulator(deps.req);
  for await (const chunk of workerStream<MapRequest, MapReplyChunk>(mapWorker(), deps.req, ctx)) {
    acc.write(chunk);
    yield acc.snapshot();
  }
}

export const graph = hotCellGraph(
  appScope.name,
  () => {
    // ---- the slit bench (overview + "from two to many") ----------------------

    /** The slit-bench wave map: a plane wave through the N-slit mask. */
    const slitBench = cell(
      () =>
        canWorker
          ? { req: slitBenchRequest(lambda.get(), pitch.get(), nSlits.get(), incidentDeg.get()) }
          : undefined,
      mapCompute,
      { scope: appScope },
    );

    /** Far-field power |A(sinθ)|² of the slit bench's exit field, with the
     *  grating-equation prediction alongside. */
    const slitFar = cell(
      () => ({
        l: lambda.get(),
        p: pitch.get(),
        n: nSlits.get(),
        inc: incidentDeg.get(),
      }),
      ({ l, p, n, inc }) => {
        const f = sourcesOnGrid(
          [{ kind: "plane", angleDeg: inc, amp: 1 }],
          FILM.n,
          FILM.dx,
          FILM.x0,
          0,
          l,
        );
        const mask = slitMask(p, n);
        applyTransmission(f, mask.re, mask.im);
        const ff = farField(f, l, { sinMax: 0.7 });
        return {
          sin: ff.sin,
          power: ff.power,
          color: tintFor(l),
          orders: gratingOrders(l, p, inc, 0.7),
        };
      },
      { scope: appScope },
    );

    /** The design readouts the bench quotes: order fan, kick size, R = mN. */
    const benchNumbers = cell(
      () => ({ l: lambda.get(), p: pitch.get(), n: nSlits.get(), inc: incidentDeg.get() }),
      ({ l, p, n, inc }) => ({
        orders: gratingOrders(l, p, inc),
        resolve: resolvingPower(p, n),
        kick: l / p,
      }),
      { scope: appScope },
    );

    // ---- the two-source lab --------------------------------------------------

    /** The two-source wave map (pure Huygens, no element). */
    const twoSrcMap = cell(
      () => (canWorker ? { req: twoSourceRequest(lambda.get(), srcSep.get()) } : undefined),
      mapCompute,
      { scope: appScope },
    );

    /** Intensity along the screen line at z = 560 µm. */
    const screenLine = cell(
      () => ({ l: lambda.get(), d: srcSep.get() }),
      ({ l, d }) => {
        const f = sourcesOnGrid(twoSources(l, d), 660, 1, -330, SCREEN_Z, l);
        return { data: intensity(f), x0: -330, dx: 1, color: tintFor(l) };
      },
      { scope: appScope },
    );

    /** The two arrows at the probe point — one per source. */
    const probeArrows = cell(
      () => ({ l: lambda.get(), d: srcSep.get(), px: probeX.get(), pz: probeZ.get() }),
      ({ l, d, px, pz }) => {
        const [s1, s2] = twoSources(l, d);
        return {
          arrows: [
            { ...sourceAt(s1, px, pz, l), color: "#7aa2f7", label: "left" },
            { ...sourceAt(s2, px, pz, l), color: "#f0a35e", label: "right" },
          ],
          tint: tintFor(l),
        };
      },
      { scope: appScope },
    );

    /** One arrow per SLIT, in the far field of the probe's DIRECTION (the
     *  textbook N-slit construction, and exactly what the far-field chart
     *  plots): neighbor-to-neighbor phase step k·Λ·sinθ. On an order, every
     *  step is a whole turn — N arrows align; a hair off, they close into a
     *  spiral. (A point probe this close would add Fresnel curvature and blur
     *  the lesson — direction space is where orders live.) */
    const slitArrows = cell(
      () => ({
        l: lambda.get(),
        p: pitch.get(),
        n: nSlits.get(),
        px: probeX.get(),
        pz: probeZ.get(),
      }),
      ({ l, p, n, px, pz }) => {
        const sinDir = px / Math.hypot(px, pz);
        const k = (2 * Math.PI) / l;
        const first = -((n - 1) / 2) * p;
        const arrows = [];
        for (let j = 0; j < n; j++) {
          const xs = first + j * p;
          if (Math.abs(xs) > 768) continue;
          const ph = k * xs * sinDir;
          arrows.push({ re: Math.cos(ph), im: Math.sin(ph) });
        }
        return { arrows, sinDir, tint: tintFor(l) };
      },
      { scope: appScope },
    );

    // ---- the spectrometer ----------------------------------------------------

    /** Six wavelengths through the same mask, as an RGB intensity map. */
    const spectroMap = cell(
      () => (canWorker ? { req: spectrometerRequest(pitch.get(), nSlits.get()) } : undefined),
      mapCompute,
      { scope: appScope },
    );

    /** Per-λ far fields for the spectrometer chart, plus the design readouts:
     *  the m=1 fan span, resolving power, and the order-overlap check. */
    const spectroChart = cell(
      () => ({ p: pitch.get(), n: nSlits.get() }),
      ({ p, n }) => {
        const mask = slitMask(p, n);
        const series = SPECTRO_LAMBDAS.map((l) => {
          const f = sourcesOnGrid(
            [{ kind: "plane", angleDeg: 0, amp: 1 }],
            FILM.n,
            FILM.dx,
            FILM.x0,
            0,
            l,
          );
          applyTransmission(f, mask.re, mask.im);
          const ff = farField(f, l, { sinMax: 0.7 });
          return { sin: ff.sin, power: ff.power, color: tintFor(l), label: `${l} µm` };
        });
        const lMin = SPECTRO_LAMBDAS[0];
        const lMax = SPECTRO_LAMBDAS[SPECTRO_LAMBDAS.length - 1];
        const R = resolvingPower(p, n);
        const asinDeg = (s: number): number => (Math.asin(Math.min(0.95, s)) * 180) / Math.PI;
        return {
          series,
          fan: { from: asinDeg(lMin / p), to: asinDeg(lMax / p) },
          resolve: R,
          dLambdaMid: (lMin + lMax) / 2 / R,
          // m=2 of the shortest λ lands inside the m=1 fan when 2λmin < λmax
          overlap: 2 * lMin < lMax,
          overlapDeg: asinDeg((2 * lMin) / p),
        };
      },
      { scope: appScope },
    );

    // ---- the stripe lens -----------------------------------------------------

    /** The sculpting bench: plane wave through the zone plate. */
    const sculptMap = cell(
      () =>
        canWorker
          ? { req: sculptRequest(lambda.get(), zoneF.get(), incidentDeg.get()) }
          : undefined,
      mapCompute,
      { scope: appScope },
    );

    /** The lens-law prediction for the imaging bench (and the chromatic foci
     *  of the ±20% sidebands the white-light toggle adds). */
    const lensNumbers = cell(
      () => ({ l: lambda.get(), f: zoneF.get(), zo: objDist.get(), xo: objX.get() }),
      ({ l, f, zo, xo }) => {
        const img = lensImage(zo, f);
        return {
          ...img,
          imageX: xo * img.magnification,
          fBlue: zoneFocalAt(f, l, l * 0.8),
          fRed: zoneFocalAt(f, l, l * 1.2),
        };
      },
      { scope: appScope },
    );

    /** The imaging bench: a point object through the stripe lens. */
    const imagingMap = cell(
      () =>
        canWorker
          ? { req: imagingRequest(lambda.get(), zoneF.get(), objX.get(), objDist.get()) }
          : undefined,
      mapCompute,
      { scope: appScope },
    );

    /** The same bench under three wavelengths (held while the toggle is off). */
    const imagingWhiteMap = cell(
      () =>
        canWorker && whiteLight.get()
          ? { req: imagingWhiteRequest(lambda.get(), zoneF.get(), objX.get(), objDist.get()) }
          : undefined,
      mapCompute,
      { scope: appScope },
    );

    return {
      slitBench,
      slitFar,
      benchNumbers,
      twoSrcMap,
      screenLine,
      probeArrows,
      slitArrows,
      spectroMap,
      spectroChart,
      sculptMap,
      lensNumbers,
      imagingMap,
      imagingWhiteMap,
    };
  },
  import.meta.hot,
);

/** The graph's shape, inferred — components type against it. */
export type AppGraph = ReturnType<typeof graph>;

// --- the agent surface ---------------------------------------------------------

const kit = agentToolkit(appScope.name);
registerStandardTools(kit);

/** Return every control to its default: the bench as the page first loads. */
action({
  scope: appScope,
  name: "resetBench",
  run: () => {
    lambda.set(8);
    pitch.set(40);
    nSlits.set(24);
    incidentDeg.set(0);
    srcSep.set(90);
    probeX.set(70);
    probeZ.set(330);
    zoneF.set(380);
    objX.set(-30);
    objDist.set(600);
    whiteLight.set(false);
    return { reset: true };
  },
});

/** Aim the probe down a first-order direction at the current bench settings —
 *  the slit-arrow dial should then read near-aligned (bright). */
action({
  scope: appScope,
  name: "probeFirstOrder",
  run: () => {
    const s = Math.sin((incidentDeg.get() * Math.PI) / 180) + lambda.get() / pitch.get();
    const z = 420;
    const x = Math.max(-300, Math.min(300, (s / Math.sqrt(Math.max(0.05, 1 - s * s))) * z));
    probeX.set(Math.round(x));
    probeZ.set(z);
    return { probeX: probeX.get(), probeZ: probeZ.get(), sinTheta: s };
  },
});
