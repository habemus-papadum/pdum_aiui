/**
 * store.ts — the control surface of the gratings notebook (playbook layer 2,
 * durable side). One instrument bench, several apparatuses, ONE set of shared
 * knobs: the wavelength and the grating geometry deliberately thread through
 * every section, so changing λ in one section visibly moves the zone-plate
 * focus two sections down — the chromatic link the page teaches.
 *
 * Doc comments here are compiler-lifted: they are the agent-facing
 * descriptions behind the derived `set` tool. Editing this file full-reloads;
 * the graph (graph.ts) and components (ui/) are the live-editable parts.
 */

import { control, scope } from "@habemus-papadum/aiui-viz";

/** The app's instance scope: qualifies every control/durable/cell/action and
 * names the graph key + agent toolkit (window.__gratings). Thread it through
 * every declaration. */
export const appScope = scope("gratings");

// --- the light ---------------------------------------------------------------

/** Wavelength λ of the bench's light, µm. The bench runs scaled up (µm-scale
 *  light instead of 0.4–0.7 µm) so the wave texture is visible on screen;
 *  diffraction is scale-free, so every angle and λ/Λ ratio is faithful.
 *  Color-coded violet→red across the 4.5–13.5 µm band. */
export const lambda = control({
  scope: appScope,
  value: 8,
  min: 4.5,
  max: 13.5,
  step: 0.1,
  unit: "µm",
});

/** Show the traveling wave (animated Re E·e^{−iωt}). Off = the time-averaged
 *  intensity |E|² — the only thing film, a detector, or an eye can see. */
export const showWave = control({ scope: appScope, value: true });

// --- the grating -------------------------------------------------------------

/** Grating pitch Λ: centre-to-centre slit spacing, µm. THE steering knob —
 *  every order angle follows sinθ = sinθin + mλ/Λ. */
export const pitch = control({
  scope: appScope,
  value: 40,
  min: 16,
  max: 110,
  step: 1,
  unit: "µm",
});

/** Number of slits in the mask. Two gives Young fringes; many sharpen each
 *  order into a needle (resolving power R = m·N). */
export const nSlits = control({ scope: appScope, value: 24, min: 2, max: 40, step: 1 });

/** Incident beam angle, degrees off the axis. The grating adds its kick to
 *  sinθin — the whole fan shears sideways together. */
export const incidentDeg = control({
  scope: appScope,
  value: 0,
  min: -12,
  max: 12,
  step: 0.5,
  unit: "°",
});

// --- the two-source lab ------------------------------------------------------

/** Separation d between the two point sources, µm. Fringe spacing on the
 *  screen goes as λ·L/d — closer sources, wider fringes. */
export const srcSep = control({
  scope: appScope,
  value: 90,
  min: 24,
  max: 220,
  step: 2,
  unit: "µm",
});

/** Probe x: where the phasor dial samples the field, µm (dragging on the
 *  two-source map moves it too). */
export const probeX = control({
  scope: appScope,
  value: 70,
  min: -300,
  max: 300,
  step: 1,
  unit: "µm",
});

/** Probe z: the probe point's distance downstream, µm. */
export const probeZ = control({
  scope: appScope,
  value: 330,
  min: 30,
  max: 600,
  step: 1,
  unit: "µm",
});

// --- the stripe lens ---------------------------------------------------------

/** Zone-plate focal length f (designed at the current λ), µm. This knob
 *  rewrites the stripes: the plate's local pitch is λf/|x|. */
export const zoneF = control({
  scope: appScope,
  value: 380,
  min: 260,
  max: 900,
  step: 10,
  unit: "µm",
});

/** Object point transverse position on the imaging bench, µm. */
export const objX = control({
  scope: appScope,
  value: -30,
  min: -80,
  max: 80,
  step: 1,
  unit: "µm",
});

/** Object point distance upstream of the stripe lens, µm. Against f it sets
 *  the image distance and magnification through the lens law. */
export const objDist = control({
  scope: appScope,
  value: 600,
  min: 320,
  max: 900,
  step: 10,
  unit: "µm",
});

/** Illuminate the imaging bench with three wavelengths at once (0.8λ, λ, 1.2λ).
 *  The stripe lens focuses each at its own depth — chromatic blur, the
 *  spectrometer's virtue reappearing as a lens defect. */
export const whiteLight = control({ scope: appScope, value: false });
