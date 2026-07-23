/**
 * bench.ts — the pure layer (playbook layer 1) of the gratings notebook: the
 * geometry of each apparatus, the map-job builders the worker consumes, and
 * the small design formulas the readouts display (order angles, resolving
 * power, the lens law). No solid-js, no DOM — unit-tested in bench.test.ts.
 *
 * Everything here leans on @habemus-papadum/aiui-optics: elements are
 * transmissions on the FILM grid; field maps are MapRequests streamed by the
 * shared runner.
 */
import {
  apertureWindow,
  composeTransmission,
  type MapRequest,
  type Rgb,
  type SourceSpec,
  slitArray,
  type Transmission,
  waveColor,
  zonePlate,
} from "@habemus-papadum/aiui-optics";

/** The display-color band for the bench's scaled-up wavelengths, µm. */
export const LAMBDA_BAND: readonly [number, number] = [4.5, 13.5];

/** The element ("film") grid every mask is built on: ±768 µm at 0.75 µm. */
export const FILM = { n: 2048, dx: 0.75, x0: -768 } as const;
const FILM_HALF = 768;

/** Transverse window every map shares, µm. */
export const MAP_X: readonly [number, number] = [-330, 330];

/** The two-source lab's screen plane, µm downstream. */
export const SCREEN_Z = 560;

export const tintFor = (lambda: number): Rgb => waveColor(lambda, LAMBDA_BAND);

// --- design formulas (the numbers the page quotes) ----------------------------

export interface Order {
  m: number;
  sin: number;
  deg: number;
}

/** Grating-equation fan: every order with |sinθ| below the cutoff. */
export function gratingOrders(
  lambda: number,
  pitch: number,
  incidentDeg: number,
  sinMax = 0.95,
): Order[] {
  const sinIn = Math.sin((incidentDeg * Math.PI) / 180);
  const out: Order[] = [];
  for (let m = -8; m <= 8; m++) {
    const s = sinIn + (m * lambda) / pitch;
    if (Math.abs(s) <= sinMax) {
      out.push({ m, sin: s, deg: (Math.asin(s) * 180) / Math.PI });
    }
  }
  return out.sort((a, b) => a.sin - b.sin);
}

/** How many slits actually fit on the film (the mask clips at ±768 µm). */
export function effectiveSlits(pitch: number, count: number): number {
  return Math.max(1, Math.min(count, Math.floor((2 * FILM_HALF) / pitch)));
}

/** Chromatic resolving power R = λ/Δλ = m·N — with the honest slit count. */
export function resolvingPower(pitch: number, count: number, m = 1): number {
  return Math.abs(m) * effectiveSlits(pitch, count);
}

/** Thin-lens imaging: object at distance `objDist` before a lens of focal
 *  length f. Returns the image distance (+ = real, downstream) and transverse
 *  magnification, or a virtual image when the object sits inside f. */
export function lensImage(
  objDist: number,
  f: number,
): { kind: "real" | "virtual"; imageDist: number; magnification: number } {
  const inv = 1 / f - 1 / objDist;
  if (Math.abs(inv) < 1e-9) {
    return { kind: "real", imageDist: Number.POSITIVE_INFINITY, magnification: 0 };
  }
  const zi = 1 / inv;
  return {
    kind: zi > 0 ? "real" : "virtual",
    imageDist: zi,
    magnification: -zi / objDist,
  };
}

/** Where the stripe lens focuses light of wavelength λ when its zones were cut
 *  for (f₀, λ₀): f(λ) = f₀·λ₀/λ — dispersion as a lens property. */
export function zoneFocalAt(f0: number, lambda0: number, lambda: number): number {
  return (f0 * lambda0) / lambda;
}

// --- masks -------------------------------------------------------------------

export function slitMask(pitch: number, count: number): Transmission {
  return slitArray(FILM.n, FILM.dx, FILM.x0, {
    pitch,
    slitWidth: pitch * 0.42,
    count,
    center: 0,
  });
}

/** The stripe lens: an EXACT (true half-wave-zone) phase plate, apertured to
 *  ±240 µm. Exactness matters at this NA — and is the spoiler the page ends
 *  on: these zones are precisely what a point's hologram records. */
export function zoneMask(f: number, lambda: number): Transmission {
  return composeTransmission(
    zonePlate(FILM.n, FILM.dx, FILM.x0, {
      f,
      lambda,
      mode: "phase",
      phiMax: Math.PI,
      exact: true,
    }),
    apertureWindow(FILM.n, FILM.dx, FILM.x0, { center: 0, width: 480 }),
  );
}

/** Local pitch of the stripe lens at |x| (the annotation the sculpting section
 *  draws): Λ(x) = λ/sinθ(x) with sinθ(x) = x/√(x²+f²). */
export function zoneLocalPitch(f: number, lambda: number, x: number): number {
  const s = Math.abs(x) / Math.hypot(x, f);
  return s > 1e-9 ? lambda / s : Number.POSITIVE_INFINITY;
}

// --- map requests (one per apparatus) ----------------------------------------

const plane = (angleDeg: number): SourceSpec => ({ kind: "plane", angleDeg, amp: 1 });

/** The six wavelengths the spectrometer sends through the mask together. */
export const SPECTRO_LAMBDAS: readonly number[] = [4.8, 6.2, 7.6, 9.2, 11, 13];

/** The slit bench: a plane wave through the N-slit mask. */
export function slitBenchRequest(
  lambda: number,
  pitchV: number,
  count: number,
  incidentDegV: number,
): MapRequest {
  return {
    kind: "coherent",
    tint: tintFor(lambda),
    job: {
      lambda,
      nx: 440,
      nz: 480,
      x0: MAP_X[0],
      x1: MAP_X[1],
      z0: -140,
      z1: 620,
      sources: [plane(incidentDegV)],
      element: { z: 0, t: slitMask(pitchV, count) },
    },
  };
}

/** The two-source lab: a pair of point emitters, no element — pure Huygens. */
export function twoSourceRequest(lambda: number, sep: number): MapRequest {
  return {
    kind: "coherent",
    tint: tintFor(lambda),
    job: {
      lambda,
      nx: 440,
      nz: 440,
      x0: MAP_X[0],
      x1: MAP_X[1],
      z0: -80,
      z1: 620,
      sources: twoSources(lambda, sep),
    },
  };
}

export function twoSources(_lambda: number, sep: number): SourceSpec[] {
  return [
    { kind: "point", x: -sep / 2, z: 0, amp: 1 },
    { kind: "point", x: sep / 2, z: 0, amp: 1 },
  ];
}

/** The spectrometer: six wavelengths across the band through the SAME mask,
 *  accumulated as an RGB intensity map (time-averaged — white light has no
 *  single phase to animate). */
export function spectrometerRequest(pitchV: number, count: number): MapRequest {
  const mask = slitMask(pitchV, count);
  const lambdas = SPECTRO_LAMBDAS;
  return {
    kind: "rgb",
    layers: lambdas.map((l) => ({
      color: tintFor(l),
      job: {
        lambda: l,
        nx: 440,
        nz: 460,
        x0: MAP_X[0],
        x1: MAP_X[1],
        z0: -100,
        z1: 800,
        sources: [plane(0)],
        element: { z: 0, t: mask },
      },
    })),
  };
}

/** The sculpting bench: a plane wave through the stripe lens. */
export function sculptRequest(lambda: number, f: number, incidentDegV: number): MapRequest {
  return {
    kind: "coherent",
    tint: tintFor(lambda),
    job: {
      lambda,
      nx: 440,
      nz: 520,
      x0: MAP_X[0],
      x1: MAP_X[1],
      z0: -140,
      z1: 980,
      sources: [plane(incidentDegV)],
      element: { z: 0, t: zoneMask(f, lambda) },
    },
  };
}

/** The imaging bench: a point object through the stripe lens. */
export function imagingRequest(
  lambda: number,
  f: number,
  objXV: number,
  objDistV: number,
): MapRequest {
  return {
    kind: "coherent",
    tint: tintFor(lambda),
    job: {
      lambda,
      nx: 440,
      nz: 560,
      x0: MAP_X[0],
      x1: MAP_X[1],
      z0: -140,
      z1: 1150,
      sources: [{ kind: "point", x: objXV, z: -objDistV, amp: 1 }],
      element: { z: 0, t: zoneMask(f, lambda) },
    },
  };
}

/** The imaging bench under three wavelengths (0.8λ, λ, 1.2λ): the mask is cut
 *  once, at λ — the sidebands land elsewhere. */
export function imagingWhiteRequest(
  lambda: number,
  f: number,
  objXV: number,
  objDistV: number,
): MapRequest {
  const mask = zoneMask(f, lambda);
  return {
    kind: "rgb",
    layers: [0.8, 1, 1.2].map((scale) => ({
      color: tintFor(lambda * scale),
      job: {
        lambda: lambda * scale,
        nx: 440,
        nz: 560,
        x0: MAP_X[0],
        x1: MAP_X[1],
        z0: -140,
        z1: 1150,
        sources: [{ kind: "point", x: objXV, z: -objDistV, amp: 1 }],
        element: { z: 0, t: mask },
      },
    })),
  };
}
