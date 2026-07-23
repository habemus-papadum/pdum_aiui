/**
 * graph.ts — the cell graph of the holograms notebook: the darkroom pipeline
 * as dataflow. The exposure cell integrates the film; the developed cell runs
 * the darkroom; the cut cell applies the scissors; the maps and the eye read
 * whatever film currently exists. Change ANY bench knob and the whole chain
 * re-runs — the notebook's claim that a hologram is nothing but this pipeline
 * is literally the shape of this graph.
 *
 * Map cells stream from the shared worker (held where Worker doesn't exist —
 * jsdom/SSR); everything else is inline pure math. graph.test.ts probes every
 * input of every inline cell.
 */
import {
  braggCurve,
  createMapAccumulator,
  type FieldMapData,
  grainDots,
  type MapReplyChunk,
  type MapRequest,
  retinaImage,
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
  beamSplit,
  cutFilm,
  developBench,
  EYE_APERTURE,
  EYE_STANDOFF,
  exposeBench,
  FILM,
  finestFringe,
  ghostPredictions,
  LAMBDA_BAND,
  meanObjectPath,
  playbackExitField,
  playbackMapRequest,
  recordMapRequest,
  tintFor,
} from "./bench";
import {
  appScope,
  bleach,
  braggDeltaN,
  braggPeriods,
  braggShrink,
  braggTilt,
  coherenceLen,
  eyeFocus,
  eyeX,
  filmRes,
  gamma,
  lambdaRec,
  objGain,
  pathTrim,
  playAngleDeg,
  playScale,
  refAngleDeg,
  refCurved,
  refDist,
  scenePoints,
  vibration,
  winAperture,
  windowCenter,
  windowWidth,
  winEyeX,
  winEyeY,
  winFocus,
} from "./store";
import { exposePatch, retinaView2D } from "./window2d";

// --- the one durable map worker ----------------------------------------------

const canWorker = typeof Worker !== "undefined";

const mapWorker = (): Worker =>
  appScope.durable(
    "mapWorker",
    () => new Worker(new URL("./map.worker.ts", import.meta.url), { type: "module" }),
  );

/** Streamed map compute (typed explicitly so map cells infer Cell<FieldMapData>). */
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

/** The full exposure-parameter bundle (one place, several consumers). */
function exposureDeps() {
  return {
    lambda: lambdaRec.get(),
    ref: {
      lambda: lambdaRec.get(),
      angleDeg: refAngleDeg.get(),
      curved: refCurved.get(),
      dist: refDist.get(),
      pathTrim: pathTrim.get(),
    },
    points: scenePoints.get(),
    objGain: objGain.get(),
    coherenceLen: coherenceLen.get(),
    vibration: vibration.get(),
  };
}

export const graph = hotCellGraph(
  appScope.name,
  () => {
    // ---- the darkroom pipeline ----------------------------------------------

    /** What the film integrates: |R + O|², with coherence and vibration
     *  damping the cross terms. The ONLY thing the film will ever know. */
    const exposure = cell(
      () => exposureDeps(),
      (p) => {
        const e = exposeBench(p);
        return {
          exposure: e.exposure,
          mean: e.mean,
          worstContrast: e.worstContrast,
          x0: FILM.x0,
          dx: FILM.dx,
          tint: tintFor(p.lambda),
        };
      },
      { scope: appScope },
    );

    /** The developed film: exposure → transmission t(x) (the memory become an
     *  optical element), including the emulsion's resolution rolloff. */
    const developed = cell(
      () => ({
        exp: exposure(),
        gamma: gamma.get(),
        bleach: bleach.get(),
        filmRes: filmRes.get(),
      }),
      ({ exp, gamma: g, bleach: b, filmRes: fr }) => {
        const t = developBench(exp.exposure, exp.mean, { gamma: g, bleach: b, filmRes: fr });
        // display profile: |t| for amplitude film, arg(t) for bleached
        const profile = new Float64Array(t.n);
        for (let i = 0; i < t.n; i++) {
          profile[i] = b
            ? Math.atan2(t.im[i], t.re[i]) + Math.PI / 2
            : Math.hypot(t.re[i], t.im[i]);
        }
        return { t, profile, bleached: b };
      },
      { scope: appScope },
    );

    /** The film after the scissors. */
    const cut = cell(
      () => ({ dev: developed(), center: windowCenter.get(), width: windowWidth.get() }),
      ({ dev, center, width }) => ({ t: cutFilm(dev.t, center, width) }),
      { scope: appScope },
    );

    /** The emulsion's-eye view: blackened grains, denser where brighter. */
    const grains = cell(
      () => ({ exp: exposure() }),
      ({ exp }) =>
        grainDots(exp.exposure, exp.mean, { dx: FILM.dx, x0: FILM.x0 }, { count: 7000, seed: 41 }),
      { scope: appScope },
    );

    // ---- design readouts ----------------------------------------------------

    /** The bench numbers the prose quotes: fringe pitch vs emulsion, path
     *  mismatch vs coherence, fringe contrast achieved. */
    const benchNumbers = cell(
      () => ({
        p: exposureDeps(),
        fr: filmRes.get(),
        exp: exposure(),
      }),
      ({ p, fr, exp }) => {
        const finest = finestFringe(p.points, p.ref.angleDeg, p.lambda);
        return {
          finest,
          filmOk: fr <= finest * 0.75, // ≲30% MTF loss at the steepest fringe
          meanPath: meanObjectPath(p.points),
          contrast: exp.worstContrast,
        };
      },
      { scope: appScope },
    );

    /** Where the played-back light goes: image / zero-order / twin split. */
    const split = cell(
      () => ({
        c: cut(),
        mu: playScale.get(),
        lambda: lambdaRec.get(),
        angle: playAngleDeg.get(),
        points: scenePoints.get(),
      }),
      ({ c, mu, lambda, angle, points }) => beamSplit(c.t, lambda * mu, angle, points),
      { scope: appScope },
    );

    /** Paraxial ghosts: where the designer's equations put every image. */
    const ghosts = cell(
      () => ({
        points: scenePoints.get(),
        ref: {
          lambda: lambdaRec.get(),
          angleDeg: refAngleDeg.get(),
          curved: refCurved.get(),
          dist: refDist.get(),
          pathTrim: 0,
        },
        angle: playAngleDeg.get(),
        mu: playScale.get(),
      }),
      ({ points, ref, angle, mu }) => ghostPredictions(points, ref, angle, mu),
      { scope: appScope },
    );

    // ---- what the eye sees --------------------------------------------------

    /** The retina image of an eye on the rail, looking through the (cut) film
     *  at the reconstruction. Honest wave optics end to end. */
    const eyeView = cell(
      () => ({
        c: cut(),
        mu: playScale.get(),
        lambda: lambdaRec.get(),
        angle: playAngleDeg.get(),
        ex: eyeX.get(),
        focus: eyeFocus.get(),
      }),
      ({ c, mu, lambda, angle, ex, focus }) => {
        const lam = lambda * mu;
        const exit = playbackExitField(c.t, lam, angle);
        const img = retinaImage(exit, lam, {
          x: ex,
          standoff: EYE_STANDOFF,
          aperture: EYE_APERTURE,
          focusDepth: focus,
          viewHalfWidth: 300,
          nPupil: 192,
          nRetina: 200,
        });
        return { ...img, tint: tintFor(lam) };
      },
      { scope: appScope },
    );

    // ---- the two phase maps -------------------------------------------------

    /** RECORD: both beams alive in space; the film line integrating at z=0. */
    const recordMap = cell(
      () => (canWorker ? { req: recordMapRequest(exposureDeps()) } : undefined),
      mapCompute,
      { scope: appScope },
    );

    /** PLAYBACK: the reference alone, through the developed (cut) film. */
    const playbackMap = cell(
      () =>
        canWorker
          ? {
              req: playbackMapRequest(
                cut().t,
                lambdaRec.get() * playScale.get(),
                playAngleDeg.get(),
              ),
            }
          : undefined,
      mapCompute,
      { scope: appScope },
    );

    // ---- the thick film (volume / white-light) ------------------------------

    /** Reflectance of the thick emulsion across the white-light band — the
     *  Bragg stack picking its own color. */
    const braggSelect = cell(
      () => ({
        lambdaRec: lambdaRec.get(),
        periods: braggPeriods.get(),
        deltaN: braggDeltaN.get(),
        shrinkPct: braggShrink.get(),
        tiltDeg: braggTilt.get(),
      }),
      ({ lambdaRec: lr, periods, deltaN, shrinkPct, tiltDeg }) =>
        braggCurve({ lambdaRec: lr, periods, deltaN, shrink: shrinkPct / 100, tiltDeg }, [
          LAMBDA_BAND[0],
          LAMBDA_BAND[1],
        ]),
      { scope: appScope },
    );

    // ---- the finale: the 2-D window -----------------------------------------

    /** The exposed film patch under the pupil (the slow half — one scene
     *  evaluation per sample; ~50 ms at 256²). */
    const windowPatch = cell(
      () => ({ ex: winEyeX.get(), ey: winEyeY.get(), ap: winAperture.get() }),
      ({ ex, ey, ap }) => exposePatch({ eyeX: ex, eyeY: ey, aperture: ap }),
      { scope: appScope },
    );

    /** What the eye sees through the 2-D window (the cheap half — lens + FFT;
     *  the focus slider re-runs only this). */
    const windowView = cell(
      () => ({ patch: windowPatch(), focus: winFocus.get() }),
      ({ patch, focus }) => retinaView2D(patch, focus),
      { scope: appScope },
    );

    return {
      exposure,
      developed,
      cut,
      grains,
      benchNumbers,
      split,
      ghosts,
      eyeView,
      recordMap,
      playbackMap,
      braggSelect,
      windowPatch,
      windowView,
    };
  },
  import.meta.hot,
);

/** The graph's shape, inferred — components type against it. */
export type AppGraph = ReturnType<typeof graph>;

// --- the agent surface ---------------------------------------------------------

const kit = agentToolkit(appScope.name);
registerStandardTools(kit);

/** Move a scene point (0-based index) to (x, z); z must be negative
 *  (upstream of the film). Clamped to the bench's working volume. */
action({
  scope: appScope,
  name: "movePoint",
  params: { index: "0-based point index", x: "µm, −140..140", z: "µm, −1080..−380" },
  run: (args) => {
    const a = (args ?? {}) as { index?: number; x?: number; z?: number };
    const pts = scenePoints.get().slice();
    const i = Math.round(Number(a.index));
    if (!Number.isFinite(i) || i < 0 || i >= pts.length) {
      return { error: `no point ${a.index}`, count: pts.length };
    }
    pts[i] = {
      x: Math.max(-140, Math.min(140, Number(a.x) || 0)),
      z: Math.max(-1080, Math.min(-380, Number(a.z) || -700)),
    };
    scenePoints.set(pts);
    return { points: pts };
  },
});

/** Add a scene point at (x, z) — at most five points keep the bench readable. */
action({
  scope: appScope,
  name: "addPoint",
  params: { x: "µm, −140..140", z: "µm, −1080..−380" },
  run: (args) => {
    const a = (args ?? {}) as { x?: number; z?: number };
    const pts = scenePoints.get().slice();
    if (pts.length >= 5) return { error: "bench holds at most 5 points" };
    pts.push({
      x: Math.max(-140, Math.min(140, Number(a.x) || 0)),
      z: Math.max(-1080, Math.min(-380, Number(a.z) || -700)),
    });
    scenePoints.set(pts);
    return { points: pts };
  },
});

/** Remove the last scene point (at least one stays). */
action({
  scope: appScope,
  name: "removePoint",
  run: () => {
    const pts = scenePoints.get().slice();
    if (pts.length > 1) pts.pop();
    scenePoints.set(pts);
    return { points: pts };
  },
});

/** Reset the bench: default scene, matched arms, whole film, matched playback. */
action({
  scope: appScope,
  name: "resetBench",
  run: () => {
    scenePoints.set([
      { x: -70, z: -560 },
      { x: 15, z: -760 },
      { x: 80, z: -1000 },
    ]);
    lambdaRec.set(8);
    refAngleDeg.set(14);
    refCurved.set(false);
    refDist.set(900);
    objGain.set(4);
    coherenceLen.set(3000);
    pathTrim.set(0);
    vibration.set(0);
    gamma.set(1);
    bleach.set(true);
    filmRes.set(4);
    windowCenter.set(0);
    windowWidth.set(1536);
    eyeX.set(0);
    eyeFocus.set(1300);
    playScale.set(1);
    playAngleDeg.set(14);
    return { reset: true };
  },
});
