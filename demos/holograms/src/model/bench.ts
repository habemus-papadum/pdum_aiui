/**
 * bench.ts — the pure layer (playbook layer 1) of the holograms notebook: the
 * bench geometry, the record→develop→playback pipeline over the aiui-optics
 * engine, the paraxial ghost predictions the overlays draw, and the design
 * readouts (fringe pitch vs emulsion, beam-power split, path matching).
 * No solid-js, no DOM — unit-tested in bench.test.ts.
 */
import {
  type ArmSpec,
  apertureWindow,
  applyTransmission,
  type BeamAtFilm,
  composeTransmission,
  developFilm,
  exposeFilm,
  type FarField,
  type Field,
  farField,
  type HoloImagePrediction,
  holoImages,
  type MapRequest,
  planeBeam,
  pointBeam,
  power,
  powerInBand,
  type Rgb,
  type SourceSpec,
  sourcesOnGrid,
  type Transmission,
  waveColor,
} from "@habemus-papadum/aiui-optics";
import type { ScenePoint } from "./store";

/** The film grid: ±768 µm at 0.75 µm — 2048 samples of emulsion. */
export const FILM = { n: 2048, dx: 0.75, x0: -768 } as const;
export const FILM_HALF = 768;

/** Shared display-color band (same convention as demos/gratings). */
export const LAMBDA_BAND: readonly [number, number] = [4.5, 13.5];
export const tintFor = (lambda: number): Rgb => waveColor(lambda, LAMBDA_BAND);

/** Transverse window of the maps, µm. */
export const MAP_X: readonly [number, number] = [-330, 330];

/** The viewing rail: the eye's pupil plane, µm downstream of the film. */
export const EYE_STANDOFF = 500;
export const EYE_APERTURE = 300;

// --- the two arms ------------------------------------------------------------

export interface RefParams {
  lambda: number;
  angleDeg: number;
  curved: boolean;
  dist: number;
  pathTrim: number;
}

/** Mean object path (film centre → points): the baseline the bench's path-
 *  matching trombone is zeroed against, so pathTrim = 0 means MATCHED arms. */
export function meanObjectPath(points: readonly ScenePoint[]): number {
  if (points.length === 0) return 0;
  let s = 0;
  for (const p of points) s += Math.hypot(p.x, p.z);
  return s / points.length;
}

/** The reference arm: collimated at `angleDeg`, or diverging from a point
 *  `dist` away along that direction (the spreading lens). */
export function referenceArm(ref: RefParams, points: readonly ScenePoint[]): ArmSpec {
  const pathOffset = meanObjectPath(points) + ref.pathTrim;
  if (!ref.curved) {
    return { source: { kind: "plane", angleDeg: ref.angleDeg, amp: 1 }, pathOffset };
  }
  const th = (ref.angleDeg * Math.PI) / 180;
  return {
    source: {
      kind: "point",
      x: -ref.dist * Math.sin(th),
      z: -ref.dist * Math.cos(th),
      amp: 1,
    },
    pathOffset,
  };
}

/** The reference summarized for the designer's equations (paraxial a, b). */
export function referenceBeam(ref: RefParams): BeamAtFilm {
  if (!ref.curved) return planeBeam(ref.angleDeg);
  const th = (ref.angleDeg * Math.PI) / 180;
  return pointBeam(-ref.dist * Math.sin(th), ref.dist * Math.cos(th));
}

/** One arm per glowing object point (all lit by the same laser). */
export function objectArms(points: readonly ScenePoint[], objGain: number): ArmSpec[] {
  return points.map((p) => ({
    source: { kind: "point", x: p.x, z: p.z, amp: objGain } satisfies SourceSpec,
  }));
}

// --- the darkroom pipeline ---------------------------------------------------

export interface ExposureParams {
  lambda: number;
  ref: RefParams;
  points: readonly ScenePoint[];
  objGain: number;
  coherenceLen: number;
  vibration: number;
}

export function exposeBench(p: ExposureParams): ReturnType<typeof exposeFilm> {
  return exposeFilm(
    [referenceArm(p.ref, p.points), ...objectArms(p.points, p.objGain)],
    FILM.n,
    FILM.dx,
    FILM.x0,
    0,
    p.lambda,
    { coherenceLength: p.coherenceLen, vibrationRms: p.vibration },
  );
}

export interface DevelopParams {
  gamma: number;
  bleach: boolean;
  filmRes: number;
}

export function developBench(exposure: Float64Array, mean: number, d: DevelopParams): Transmission {
  return developFilm(
    exposure,
    mean,
    { dx: FILM.dx, x0: FILM.x0 },
    {
      mode: d.bleach ? "phase" : "amplitude",
      gamma: d.gamma,
      phiMax: 2,
      cutoffPeriod: d.filmRes,
    },
  );
}

/** The scissors: keep only the window (µm). Width ≥ the film = untouched. */
export function cutFilm(t: Transmission, center: number, width: number): Transmission {
  if (width >= 2 * FILM_HALF) return t;
  return composeTransmission(t, apertureWindow(FILM.n, FILM.dx, FILM.x0, { center, width }));
}

// --- design readouts ---------------------------------------------------------

/** The finest fringe pitch this recording asks the emulsion to hold, µm:
 *  min over points and film positions of λ/|sinθ_obj(x) − sinθ_ref|. */
export function finestFringe(
  points: readonly ScenePoint[],
  refAngleDeg: number,
  lambda: number,
): number {
  const sr = Math.sin((refAngleDeg * Math.PI) / 180);
  let maxDiff = 0;
  for (const p of points) {
    for (const x of [-FILM_HALF, 0, FILM_HALF]) {
      const so = (x - p.x) / Math.hypot(x - p.x, p.z);
      maxDiff = Math.max(maxDiff, Math.abs(so - sr));
    }
  }
  return maxDiff > 1e-9 ? lambda / maxDiff : Number.POSITIVE_INFINITY;
}

/** Where the played-back light goes: fractions of the transmitted power in
 *  the image band, the zero-order band, and the twin band. */
export function beamSplit(
  t: Transmission,
  lambdaPlay: number,
  playAngleDeg: number,
  points: readonly ScenePoint[],
): { image: number; zero: number; twin: number; transmitted: number; ff: FarField } {
  const f = sourcesOnGrid(
    [{ kind: "plane", angleDeg: playAngleDeg, amp: 1 }],
    FILM.n,
    FILM.dx,
    FILM.x0,
    0,
    lambdaPlay,
  );
  const powerIn = power(f);
  applyTransmission(f, t.re, t.im);
  const transmitted = powerIn > 0 ? power(f) / powerIn : 0;
  const ff = farField(f, lambdaPlay, { raw: true });
  const sp = Math.sin((playAngleDeg * Math.PI) / 180);
  // mean object direction (the image beam's centre) — near 0 for our scenes
  let so = 0;
  for (const p of points) so += -p.x / Math.hypot(p.x, p.z);
  so = points.length ? so / points.length : 0;
  // shares are of the INCIDENT power (band fraction × overall transmission) —
  // the honest efficiency: an absorbing film can't win by shrinking the pie
  return {
    image: powerInBand(ff, so, 0.13) * transmitted,
    zero: powerInBand(ff, sp, 0.05) * transmitted,
    twin: powerInBand(ff, 2 * sp - so, 0.13) * transmitted,
    transmitted,
    ff,
  };
}

/** Paraxial ghost predictions for every scene point under the current
 *  playback (µ = λplay/λrec). Virtual images land at z = −dist (behind the
 *  film, where the eye sees them); twins converge at z = +dist. */
export interface Ghost {
  point: ScenePoint;
  image: HoloImagePrediction & { z?: number };
  twin: HoloImagePrediction & { z?: number };
}

export function ghostPredictions(
  points: readonly ScenePoint[],
  ref: RefParams,
  playAngleDeg: number,
  mu: number,
): Ghost[] {
  const recBeam = referenceBeam(ref);
  const playBeam = planeBeam(playAngleDeg);
  return points.map((p) => {
    const { image, twin } = holoImages(pointBeam(p.x, -p.z), recBeam, playBeam, mu);
    return {
      point: p,
      image: { ...image, z: image.dist !== undefined ? -image.dist : undefined },
      twin: { ...twin, z: twin.dist },
    };
  });
}

// --- the exit field & maps ---------------------------------------------------

/** The field just past the (cut) film under the playback beam. */
export function playbackExitField(
  t: Transmission,
  lambdaPlay: number,
  playAngleDeg: number,
): Field {
  const f = sourcesOnGrid(
    [{ kind: "plane", angleDeg: playAngleDeg, amp: 1 }],
    FILM.n,
    FILM.dx,
    FILM.x0,
    0,
    lambdaPlay,
  );
  applyTransmission(f, t.re, t.im);
  return f;
}

/** RECORD-phase map: both beams live in space, film line at z = 0. The film
 *  region and everything downstream still shows the light — exposure is not
 *  absorption. */
export function recordMapRequest(p: ExposureParams): MapRequest {
  return {
    kind: "coherent",
    tint: tintFor(p.lambda),
    job: {
      lambda: p.lambda,
      nx: 440,
      nz: 560,
      x0: MAP_X[0],
      x1: MAP_X[1],
      z0: -1120,
      z1: 360,
      sources: [
        referenceArm(p.ref, p.points).source,
        ...objectArms(p.points, p.objGain).map((a) => a.source),
      ],
    },
  };
}

/** PLAYBACK-phase map: the reference alone meets the developed film. The
 *  extent reaches far LEFT of the film on purpose: that dark region is where
 *  the virtual images stand — the ghost dots float over the incoming beam
 *  where no reconstructed light computes, which is exactly the point. */
export function playbackMapRequest(
  t: Transmission,
  lambdaPlay: number,
  playAngleDeg: number,
): MapRequest {
  return {
    kind: "coherent",
    tint: tintFor(lambdaPlay),
    job: {
      lambda: lambdaPlay,
      nx: 440,
      nz: 660,
      x0: MAP_X[0],
      x1: MAP_X[1],
      z0: -1120,
      z1: 1000,
      sources: [{ kind: "plane", angleDeg: playAngleDeg, amp: 1 }],
      element: { z: 0, t },
    },
  };
}
