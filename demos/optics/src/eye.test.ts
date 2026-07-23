/**
 * eye.test.ts — the eye model earns the notebook's "3-D without cheating"
 * claim: a real point is seen at its true position from ANY eye position
 * (that is what parallax consistency means), focus matters, and a smaller
 * pupil sees a blurrier world.
 */
import { describe, expect, it } from "vitest";
import { type EyeSpec, retinaImage } from "./eye";
import { sourcesOnGrid } from "./field";

const LAMBDA = 8;
const N = 2048;
const DX = 0.75;
const X0 = -(N * DX) / 2;

/** The wavefront a point at (xs, −d) leaves on the film line z = 0. */
function pointField(xs: number, d: number) {
  return sourcesOnGrid([{ kind: "point", x: xs, z: -d, amp: 1 }], N, DX, X0, 0, LAMBDA);
}

/** Width holding the central 76% of the energy — robust to the ripples of a
 *  defocused PSF (whose tallest ripple has a misleadingly narrow FWHM). */
function energyWidth(img: { xApparent: Float64Array; intensity: Float64Array }): number {
  let total = 0;
  for (const v of img.intensity) total += v;
  const step = Math.abs(img.xApparent[1] - img.xApparent[0]);
  let cum = 0;
  let lo = 0;
  let hi = img.intensity.length - 1;
  for (let j = 0; j < img.intensity.length; j++) {
    cum += img.intensity[j];
    if (cum < 0.12 * total) lo = j;
    if (cum <= 0.88 * total) hi = j;
  }
  return (hi - lo) * step;
}

function peakOf(img: { xApparent: Float64Array; intensity: Float64Array }): {
  x: number;
  fwhm: number;
} {
  let bi = 0;
  let bx = 0;
  let bj = 0;
  for (let j = 0; j < img.intensity.length; j++)
    if (img.intensity[j] > bi) {
      bi = img.intensity[j];
      bx = img.xApparent[j];
      bj = j;
    }
  let lo = bj;
  let hi = bj;
  while (lo > 0 && img.intensity[lo] > bi / 2) lo--;
  while (hi < img.intensity.length - 1 && img.intensity[hi] > bi / 2) hi++;
  const step = Math.abs(img.xApparent[1] - img.xApparent[0]);
  return { x: bx, fwhm: (hi - lo) * step };
}

// A pupil that can actually resolve this bench: with λ = 8 µm the
// diffraction-limited spot is λ·d/A ≈ 8·1100/300 ≈ 29 µm, comfortably inside
// the ±160 µm view. (The benches run at scaled-up λ; the "eye" is really a
// camera/loupe scaled to match.)
const EYE: EyeSpec = {
  x: 30,
  standoff: 500,
  aperture: 300,
  focusDepth: 1100, // point at d=600 upstream of the film + 500 standoff
  viewHalfWidth: 160,
};

describe("retinaImage", () => {
  it("sees a focused point at its true transverse position", () => {
    const p = peakOf(retinaImage(pointField(30, 600), LAMBDA, EYE));
    expect(Math.abs(p.x - 30)).toBeLessThan(3);
  });

  it("parallax consistency: a different eye position still sees the point where it is", () => {
    const img = retinaImage(pointField(30, 600), LAMBDA, { ...EYE, x: 110, viewHalfWidth: 200 });
    const p = peakOf(img);
    expect(Math.abs(p.x - 30)).toBeLessThan(8);
  });

  it("accommodation: focusing at the wrong depth blurs the point", () => {
    const good = energyWidth(retinaImage(pointField(30, 600), LAMBDA, EYE));
    const bad = energyWidth(retinaImage(pointField(30, 600), LAMBDA, { ...EYE, focusDepth: 650 }));
    expect(bad).toBeGreaterThan(good * 1.6);
  });

  it("a smaller pupil resolves less (the cut-film blur, seen by the eye)", () => {
    const wide = peakOf(retinaImage(pointField(30, 600), LAMBDA, EYE));
    const narrow = peakOf(retinaImage(pointField(30, 600), LAMBDA, { ...EYE, aperture: 80 }));
    expect(narrow.fwhm).toBeGreaterThan(wide.fwhm * 2);
  });
});
