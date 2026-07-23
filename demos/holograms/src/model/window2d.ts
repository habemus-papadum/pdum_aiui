/**
 * window2d.ts — the finale's pure model: a REAL two-dimensional hologram of a
 * three-dimensional scene, and an eye pressed against it.
 *
 * The 1-D benches taught the mechanism; this is the payoff at full dimension.
 * A glowing wireframe cube hangs behind a 2-D film. The film records
 * |R + ΣO|² (a reference plane wave tilted in x, plus a spherical wave per
 * scene point) and is developed as a bleached phase film — exactly the 1-D
 * darkroom, squared. Viewing is honest Fourier optics: the eye's pupil IS a
 * patch of film (the window!); the developed patch × the playback reference ×
 * the eye's lens phase, 2-D FFT → the retina image. Nothing is ray-traced,
 * nothing painted: parallax, perspective, occlusion-free glow, and focus blur
 * all emerge from the wavefront.
 *
 * Orientation contract: the returned view reads like looking through a
 * window — scene +x appears at image +x, scene +y at image +y (the camera's
 * inversion is folded in here, once).
 */
import { fft2d, taperEdges } from "@habemus-papadum/aiui-optics";

export const WINDOW_LAMBDA = 8; // µm (same scaled bench as everywhere)
export const WINDOW_REF_SIN = 0.35; // reference tilt, x only (off-axis)
const PHI_MAX = 2; // bleached-film peak phase excursion

export interface ScenePoint3D {
  x: number;
  y: number;
  z: number; // < 0: behind the film
}

/** The scene: a glowing wireframe cube — 8 corners + front-face edge
 *  midpoints, centred on the axis ~2.8 mm behind the film. Two depths, so
 *  parallax and focus have something to disagree about. */
export const WINDOW_SCENE: readonly ScenePoint3D[] = (() => {
  const pts: ScenePoint3D[] = [];
  const H = 300;
  const zF = -2500; // front face
  const zB = -3100; // back face
  for (const z of [zF, zB]) {
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        pts.push({ x: sx * H, y: sy * H, z });
      }
    }
  }
  // front-face edge midpoints, to make the near square read as a frame
  for (const [x, y] of [
    [0, H],
    [0, -H],
    [H, 0],
    [-H, 0],
  ] as const) {
    pts.push({ x, y, z: zF });
  }
  return pts;
})();

/** Per-point amplitude at unit distance-scale (tuned so Σ|O| stays in the
 *  film's linear-ish range against |R| = 1). */
const POINT_AMP = 0.11;

/** The film's exposure |R + ΣO|² at film point (u, v). The ONE formula — the
 *  film-view shader (HoloFilmView) mirrors it in GLSL for display. */
export function exposure2DAt(u: number, v: number, points: readonly ScenePoint3D[]): number {
  const k = (2 * Math.PI) / WINDOW_LAMBDA;
  // reference: plane wave tilted in x
  let re = Math.cos(k * u * WINDOW_REF_SIN);
  let im = Math.sin(k * u * WINDOW_REF_SIN);
  for (const p of points) {
    const dx = u - p.x;
    const dy = v - p.y;
    const r = Math.sqrt(dx * dx + dy * dy + p.z * p.z);
    const a = (POINT_AMP * 2800) / r; // 3-D spherical falloff, ~POINT_AMP at the cube
    const ph = k * r;
    re += a * Math.cos(ph);
    im += a * Math.sin(ph);
  }
  return re * re + im * im;
}

export interface WindowPatchOpts {
  /** Pupil centre on the film, µm (the eye pressed to the window). */
  eyeX: number;
  eyeY: number;
  /** Pupil width = the side of the film patch actually used, µm.
   *  Capped by sampling: at n = 256, apertures ≤ 1200 µm keep even the twin
   *  order below Nyquist (dx ≤ 4.7 µm ⇒ s_max ≥ 0.85). */
  aperture: number;
  /** Patch samples per side (power of two). */
  n?: number;
  points?: readonly ScenePoint3D[];
}

/** The exposed film patch under the pupil — the slow half (one evaluation of
 *  the scene per sample); cache it and re-run only the cheap lens+FFT half
 *  when the focus changes. */
export interface WindowPatch {
  exposure: Float64Array;
  mean: number;
  n: number;
  dx: number;
  eyeX: number;
  eyeY: number;
}

export function exposePatch(opts: WindowPatchOpts): WindowPatch {
  const n = opts.n ?? 256;
  const points = opts.points ?? WINDOW_SCENE;
  const dx = opts.aperture / n;
  const exposure = new Float64Array(n * n);
  let mean = 0;
  for (let j = 0; j < n; j++) {
    const v = opts.eyeY + (j - n / 2 + 0.5) * dx;
    for (let i = 0; i < n; i++) {
      const u = opts.eyeX + (i - n / 2 + 0.5) * dx;
      const e = exposure2DAt(u, v, points);
      exposure[j * n + i] = e;
      mean += e;
    }
  }
  mean /= n * n;
  return { exposure, mean, n, dx, eyeX: opts.eyeX, eyeY: opts.eyeY };
}

export interface WindowView {
  /** m×m intensity, row-major; [0][0] is the top-left of the view
   *  (image +x right = scene +x, image up = scene +y). */
  img: Float32Array;
  m: number;
  /** Angular half-range of the crop, as sinθ. */
  sinHalf: number;
}

/**
 * What the eye sees through its patch of film: develop the patch (bleached
 * phase film, bias at the patch mean), re-light with the reference, add the
 * eye's lens phase for the chosen focus, 2-D FFT, and keep the angular band
 * around the image (the zero order at sinθ = 0.35 and the twin beyond it
 * fall outside the crop — off-axis holography doing its job in 2-D).
 */
export function retinaView2D(patch: WindowPatch, focus: number): WindowView {
  const { n, dx, mean, exposure } = patch;
  const lambda = WINDOW_LAMBDA;
  const k = (2 * Math.PI) / lambda;

  // develop (bleach) → t = e^{iφ}, φ = PHI_MAX·E/(2Ē); re-light with R;
  // add the lens phase for the focus depth (centred on the pupil)
  const re = new Float64Array(n * n);
  const im = new Float64Array(n * n);
  const denom = mean > 0 ? 2 * mean : 1;
  for (let j = 0; j < n; j++) {
    const vOff = (j - n / 2 + 0.5) * dx;
    for (let i = 0; i < n; i++) {
      const uOff = (i - n / 2 + 0.5) * dx;
      const u = patch.eyeX + uOff;
      const phFilm = (PHI_MAX * exposure[j * n + i]) / denom;
      const phRef = k * u * WINDOW_REF_SIN;
      const phLens = (-k * (uOff * uOff + vOff * vOff)) / (2 * focus);
      const ph = phFilm + phRef + phLens;
      re[j * n + i] = Math.cos(ph);
      im[j * n + i] = Math.sin(ph);
    }
  }

  // soft-edge the patch (kill FFT wraparound ringing), rows and columns
  for (let j = 0; j < n; j++) {
    taperEdges({
      n,
      dx,
      x0: 0,
      re: re.subarray(j * n, (j + 1) * n),
      im: im.subarray(j * n, (j + 1) * n),
    });
  }
  const colRe = new Float64Array(n);
  const colIm = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      colRe[j] = re[j * n + i];
      colIm[j] = im[j * n + i];
    }
    taperEdges({ n, dx, x0: 0, re: colRe, im: colIm });
    for (let j = 0; j < n; j++) {
      re[j * n + i] = colRe[j];
      im[j * n + i] = colIm[j];
    }
  }

  // 4. the lens's Fourier transform
  fft2d(re, im, n, n);

  // 5. crop the image band. FFT bin (fx, fy) ↔ outgoing direction s = λ·f.
  //    A scene point at p (left of the eye) leaves as a beam with s < 0, and
  //    a window view should show it on the LEFT — so display at −s.
  const sinHalf = 0.17;
  const df = 1 / (n * dx);
  const half = Math.floor(sinHalf / (lambda * df));
  const m = 2 * half + 1;
  const img = new Float32Array(m * m);
  const binOf = (f: number): number => {
    // fftfreq layout: [0.. +, −..]; find index of frequency f (cycles/µm)
    const idx = Math.round(f / df);
    return idx >= 0 ? idx : n + idx;
  };
  for (let oy = 0; oy < m; oy++) {
    // row 0 = top of the view = display sy +sinHalf; column 0 = left = −sinHalf
    const sy = sinHalf - (oy / (m - 1)) * 2 * sinHalf;
    for (let ox = 0; ox < m; ox++) {
      const sx = -sinHalf + (ox / (m - 1)) * 2 * sinHalf;
      // display at −s (the window flip), so the bin sits at f = −s/λ
      const bx = binOf(-sx / lambda);
      const by = binOf(-sy / lambda);
      const p = re[by * n + bx] ** 2 + im[by * n + bx] ** 2;
      img[oy * m + ox] = p;
    }
  }
  return { img, m, sinHalf };
}

/** Where a scene point should appear in the view (for tests and overlays):
 *  the beam it reconstructs travels with s = (eye − p)/r; the view flips it. */
export function apparentDirection(
  p: ScenePoint3D,
  eyeX: number,
  eyeY: number,
): { sx: number; sy: number } {
  const r = Math.sqrt((eyeX - p.x) ** 2 + (eyeY - p.y) ** 2 + p.z * p.z);
  return { sx: -(eyeX - p.x) / r, sy: -(eyeY - p.y) / r };
}
