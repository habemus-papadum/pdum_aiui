/**
 * store.ts — the control surface of the holograms notebook (playbook layer 2,
 * durable side): one virtual bench with two phases — RECORD (laser split into
 * a reference beam and an object beam; the film integrates |E|²) and PLAYBACK
 * (the developed film re-lit by the reference alone). Every knob is a real
 * bench decision: the reference geometry, the exposure and development, the
 * emulsion's resolution, the scissors, and the playback remixes.
 *
 * Doc comments are compiler-lifted into the agent registry. Editing this file
 * full-reloads; graph.ts and ui/ are the live-editable parts.
 */

import { control, scope } from "@habemus-papadum/aiui-viz";

/** The app's instance scope: qualifies every control/durable/cell/action and
 * names the graph key + agent toolkit (window.__holograms). */
export const appScope = scope("holograms");

// --- the bench phase ---------------------------------------------------------

/** OFF = record (both beams on, film integrating). ON = playback: the object
 *  is GONE — only the reference shines through the developed film. */
export const playback = control({ scope: appScope, value: false });

/** Show the traveling wave (animated). Off = time-averaged intensity — the
 *  only thing the film ever saw, and the crux of the whole subject. */
export const showWave = control({ scope: appScope, value: true });

// --- the light & the reference arm -------------------------------------------

/** Recording wavelength λ, µm (scaled-up bench; ratios are faithful). */
export const lambdaRec = control({
  scope: appScope,
  value: 8,
  min: 5,
  max: 12,
  step: 0.1,
  unit: "µm",
});

/** Reference beam angle, degrees off the film normal. Off-axis is what keeps
 *  the played-back image away from the straight-through beam (Leith–Upatnieks);
 *  it also sets the fringe pitch the film must hold: Λ ≈ λ/sinθ. */
export const refAngleDeg = control({
  scope: appScope,
  value: 22,
  min: 8,
  max: 30,
  step: 0.5,
  unit: "°",
});

/** Send the reference through a spreading lens: a DIVERGING reference from a
 *  point `refDist` away instead of a collimated beam. Recording with a curved
 *  reference then playing back collimated projects a magnified image. */
export const refCurved = control({ scope: appScope, value: false });

/** The spreading lens's virtual source distance, µm (with `refCurved` on). */
export const refDist = control({
  scope: appScope,
  value: 900,
  min: 500,
  max: 2500,
  step: 50,
  unit: "µm",
});

/** Object-beam brightness relative to the reference. Fringe contrast rises
 *  with it — but so does the object's self-interference (the |O|² halo);
 *  holographers keep the reference a few times stronger for linearity. */
export const objGain = control({ scope: appScope, value: 4, min: 1, max: 9, step: 0.5 });

// --- the bench's failure modes (the kit section) -----------------------------

/** Laser coherence length, µm: arms only interfere while their path lengths
 *  agree within this. Real benches path-match with mirrors; here, drag
 *  `pathTrim` past it and watch the fringes die. */
export const coherenceLen = control({
  scope: appScope,
  value: 3000,
  min: 150,
  max: 6000,
  step: 50,
  unit: "µm",
});

/** Extra path length inserted in the reference arm, µm (the path-matching
 *  trombone). Fringes need |trim| ≲ the coherence length. */
export const pathTrim = control({
  scope: appScope,
  value: 0,
  min: -4000,
  max: 4000,
  step: 50,
  unit: "µm",
});

/** Bench vibration during the exposure, RMS in wavelengths. λ/4 of drift
 *  smears the fringes to almost nothing — why holography tables are granite. */
export const vibration = control({ scope: appScope, value: 0, min: 0, max: 0.5, step: 0.01 });

// --- the film & the darkroom -------------------------------------------------

/** Development strength γ: how strongly exposure converts to transmission
 *  change (amplitude film) or phase delay (bleached). */
export const gamma = control({ scope: appScope, value: 1, min: 0.2, max: 1.5, step: 0.05 });

/** Bleach the developed silver into a clear phase relief. Same stripes,
 *  written as delay instead of absorption: ~6% → ~34% into the image. */
export const bleach = control({ scope: appScope, value: true });

/** Emulsion resolution: the finest stripe period the film can hold, µm
 *  (−50% response at this period). Fringes are λ/sinθ ≈ tens of µm here —
 *  real holographic film resolves ~0.2 µm, 25× beyond camera film. */
export const filmRes = control({
  scope: appScope,
  value: 4,
  min: 2,
  max: 120,
  step: 2,
  unit: "µm",
});

// --- the scissors (cut the film) ---------------------------------------------

/** Centre of the kept piece of film, µm. */
export const windowCenter = control({
  scope: appScope,
  value: 0,
  min: -700,
  max: 700,
  step: 10,
  unit: "µm",
});

/** Width of the kept piece, µm (1536 = the whole film). Every piece still
 *  shows the whole scene — through a smaller window, dimmer and blurrier. */
export const windowWidth = control({
  scope: appScope,
  value: 1536,
  min: 60,
  max: 1536,
  step: 4,
  unit: "µm",
});

// --- the eye on the rail -----------------------------------------------------

/** Eye position along the viewing rail (500 µm behind the film), µm. Slide it
 *  and watch the parallax: near points shift against far ones. */
export const eyeX = control({
  scope: appScope,
  value: 0,
  min: -280,
  max: 280,
  step: 5,
  unit: "µm",
});

/** Accommodation: the depth the eye focuses at, µm in front of the pupil.
 *  Focus on a near point and the far ones blur — the reconstruction has real
 *  depth, not painted depth. */
export const eyeFocus = control({
  scope: appScope,
  value: 1300,
  min: 500,
  max: 3200,
  step: 25,
  unit: "µm",
});

// --- playback remixes --------------------------------------------------------

/** Playback wavelength, as a multiple µ of the recording λ. The image depth
 *  scales as 1/µ (Gabor's plan: record with Å-wavelength electrons, view in
 *  visible light — magnification = the wavelength ratio). */
export const playScale = control({ scope: appScope, value: 1, min: 0.6, max: 1.8, step: 0.05 });

/** Playback beam angle, degrees. Mismatch it against the recording reference
 *  and the whole scene swings to a new direction (the image rides the beam). */
export const playAngleDeg = control({
  scope: appScope,
  value: 22,
  min: 8,
  max: 30,
  step: 0.5,
  unit: "°",
});

// --- the object (durable, not a slider) --------------------------------------

export interface ScenePoint {
  x: number;
  z: number;
}

/** The glowing points of the object — draggable on the record map; agents add
 *  and move them through the scene actions. */
export const scenePoints = appScope.durableSignal<ScenePoint[]>("scenePoints", [
  { x: -70, z: -560 },
  { x: 15, z: -760 },
  { x: 80, z: -1000 },
]);
