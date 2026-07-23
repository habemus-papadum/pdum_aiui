/**
 * window2d.test.ts — the finale's claims, held as tests: a point's glow
 * reappears at its apparent direction, parallax follows the eye across the
 * film, a smaller patch blurs the view, and focus discriminates the cube's
 * two faces.
 */
import { describe, expect, it } from "vitest";
import {
  apparentDirection,
  exposePatch,
  retinaView2D,
  type ScenePoint3D,
  WINDOW_SCENE,
} from "./window2d";

/** Brightest view pixel, as an angular direction (matching the view's flip). */
function peakDirection(v: ReturnType<typeof retinaView2D>): { sx: number; sy: number; p: number } {
  let best = 0;
  let bx = 0;
  let by = 0;
  for (let y = 0; y < v.m; y++) {
    for (let x = 0; x < v.m; x++) {
      const p = v.img[y * v.m + x];
      if (p > best) {
        best = p;
        bx = x;
        by = y;
      }
    }
  }
  return {
    sx: -v.sinHalf + (bx / (v.m - 1)) * 2 * v.sinHalf,
    sy: v.sinHalf - (by / (v.m - 1)) * 2 * v.sinHalf,
    p: best,
  };
}

/** Sum of view intensity within a small angular disc. */
function powerNear(
  v: ReturnType<typeof retinaView2D>,
  sx0: number,
  sy0: number,
  rad: number,
): number {
  let acc = 0;
  for (let y = 0; y < v.m; y++) {
    const sy = v.sinHalf - (y / (v.m - 1)) * 2 * v.sinHalf;
    for (let x = 0; x < v.m; x++) {
      const sx = -v.sinHalf + (x / (v.m - 1)) * 2 * v.sinHalf;
      if ((sx - sx0) ** 2 + (sy - sy0) ** 2 < rad * rad) acc += v.img[y * v.m + x];
    }
  }
  return acc;
}

const ONE_POINT: ScenePoint3D[] = [{ x: 220, y: -120, z: -2800 }];

describe("the 2-D window", () => {
  it("a single point reappears at its apparent direction (window orientation: +x right, +y up)", () => {
    const patch = exposePatch({ eyeX: 0, eyeY: 0, aperture: 1000, points: ONE_POINT });
    const view = retinaView2D(patch, 2800);
    const want = apparentDirection(ONE_POINT[0], 0, 0);
    const got = peakDirection(view);
    expect(Math.abs(got.sx - want.sx)).toBeLessThan(0.015);
    expect(Math.abs(got.sy - want.sy)).toBeLessThan(0.015);
    // sanity on the sign convention itself: point at +x, −y from the eye
    expect(want.sx).toBeGreaterThan(0);
    expect(want.sy).toBeLessThan(0);
  });

  it("parallax: slide the eye across the film and the point's direction shifts accordingly", () => {
    // ±200 µm keeps the point inside the ±0.17 view crop at both stances
    const a = peakDirection(
      retinaView2D(exposePatch({ eyeX: -200, eyeY: 0, aperture: 1000, points: ONE_POINT }), 2800),
    );
    const b = peakDirection(
      retinaView2D(exposePatch({ eyeX: 200, eyeY: 0, aperture: 1000, points: ONE_POINT }), 2800),
    );
    const wantA = apparentDirection(ONE_POINT[0], -200, 0);
    const wantB = apparentDirection(ONE_POINT[0], 200, 0);
    expect(Math.abs(a.sx - wantA.sx)).toBeLessThan(0.015);
    expect(Math.abs(b.sx - wantB.sx)).toBeLessThan(0.015);
    // the shift itself: ~400/2820 ≈ 0.14 of parallax
    expect(a.sx - b.sx).toBeGreaterThan(0.1);
  });

  it("cut the window down and the view blurs (aperture diffraction)", () => {
    const wide = retinaView2D(
      exposePatch({ eyeX: 0, eyeY: 0, aperture: 1000, points: ONE_POINT }),
      2800,
    );
    const narrow = retinaView2D(
      exposePatch({ eyeX: 0, eyeY: 0, aperture: 360, points: ONE_POINT }),
      2800,
    );
    // angular resolution λ/aperture: the crop holds ~3× fewer bins
    expect(narrow.m).toBeLessThan(wide.m * 0.5);
    // but the point is still there, in place
    const got = peakDirection(narrow);
    const want = apparentDirection(ONE_POINT[0], 0, 0);
    expect(Math.abs(got.sx - want.sx)).toBeLessThan(0.03);
  });

  it("focus discriminates the cube's two faces", () => {
    const patch = exposePatch({ eyeX: 0, eyeY: 0, aperture: 1200 });
    const front = WINDOW_SCENE[0]; // z −2500 corner
    const back = WINDOW_SCENE[4]; // z −3100 corner
    const dirF = apparentDirection(front, 0, 0);
    const dirB = apparentDirection(back, 0, 0);
    const focusFront = retinaView2D(patch, 2500);
    const focusBack = retinaView2D(patch, 3100);
    // focusing front sharpens the front corner (more power concentrated near it)
    const fF = powerNear(focusFront, dirF.sx, dirF.sy, 0.012);
    const fB = powerNear(focusBack, dirF.sx, dirF.sy, 0.012);
    expect(fF).toBeGreaterThan(fB * 1.15);
    // and vice versa for the back corner
    const bB = powerNear(focusBack, dirB.sx, dirB.sy, 0.012);
    const bF = powerNear(focusFront, dirB.sx, dirB.sy, 0.012);
    expect(bB).toBeGreaterThan(bF * 1.15);
  });

  it("the whole cube shows: every corner direction carries power", () => {
    const patch = exposePatch({ eyeX: 0, eyeY: 0, aperture: 1200 });
    const view = retinaView2D(patch, 2800);
    let total = 0;
    for (const v of view.img) total += v;
    const meanCell = total / (view.m * view.m);
    for (const p of WINDOW_SCENE) {
      const d = apparentDirection(p, 0, 0);
      // each glow spot beats the view's mean by a healthy factor
      expect(powerNear(view, d.sx, d.sy, 0.014)).toBeGreaterThan(meanCell * 4);
    }
  });
});
