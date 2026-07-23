/**
 * holography.test.ts — the whole story, end to end, as tests: expose a film
 * to reference + object, develop it into a transmission, shine the reference
 * back through, and check that the object's light actually comes back — at
 * the positions the paraxial designer's equations (holo.ts) predict. Plus the
 * claims the notebook makes about cut-down film, coherence, vibration, and
 * emulsion resolution.
 */
import { describe, expect, it } from "vitest";
import { apertureWindow, composeTransmission, type Transmission } from "./elements";
import { retinaImage } from "./eye";
import { applyTransmission, type Field, sourcesOnGrid } from "./field";
import { type ArmSpec, developFilm, exposeFilm, grainDots, lowpassTransmission } from "./film";
import { holoImages, planeBeam, pointBeam } from "./holo";
import { farField, planPropagation, powerInBand, propagateTo } from "./propagate";

const LAMBDA = 8;
const N = 2048;
const DX = 0.75;
const X0 = -(N * DX) / 2;

const REF_DEG = 12;
const REF: ArmSpec = { source: { kind: "plane", angleDeg: REF_DEG, amp: 1 } };

function record(
  arms: ArmSpec[],
  opts?: Parameters<typeof exposeFilm>[6],
  mode: "amplitude" | "phase" = "amplitude",
): Transmission {
  const exp = exposeFilm(arms, N, DX, X0, 0, LAMBDA, opts);
  return developFilm(exp.exposure, exp.mean, { dx: DX, x0: X0 }, { mode, gamma: 1 });
}

// Point-object benches keep a paraxial geometry (recording zone ±400 µm, object
// 2.5 mm away → NA ≈ 0.16, reference 6°) — like a real bench, where film is
// small compared to distances. The virtual image is exact at ANY aperture (the
// film stores the object's exact wavefront); it is the *twin* and remixed
// playbacks whose paraxial predictions need a paraxial bench to land.
const PT_REF_DEG = 6;
const PT_REF: ArmSpec = { source: { kind: "plane", angleDeg: PT_REF_DEG, amp: 1 } };
const PT_ZONE = apertureWindow(N, DX, X0, { center: 0, width: 800 });

function playback(t: Transmission, ref: ArmSpec = REF): Field {
  const f = sourcesOnGrid([ref.source], N, DX, X0, 0, LAMBDA);
  applyTransmission(f, t.re, t.im);
  return f;
}

describe("record → develop → playback", () => {
  it("a recorded plane wave comes back out at its own angle (plus the twin at the mirror angle)", () => {
    const objDeg = 3;
    const t = record([REF, { source: { kind: "plane", angleDeg: objDeg, amp: 1 } }]);
    const ff = farField(playback(t), LAMBDA, { raw: true });
    const sObj = Math.sin((objDeg * Math.PI) / 180);
    const sRef = Math.sin((REF_DEG * Math.PI) / 180);
    // the resurrected object beam
    expect(powerInBand(ff, sObj, 0.02)).toBeGreaterThan(0.03);
    // the zero-order (straight-through reference)
    expect(powerInBand(ff, sRef, 0.02)).toBeGreaterThan(0.3);
    // the conjugate twin, mirrored about the reference
    expect(powerInBand(ff, 2 * sRef - sObj, 0.02)).toBeGreaterThan(0.03);
    // and nothing anywhere else
    expect(powerInBand(ff, sObj - 0.1, 0.02)).toBeLessThan(0.005);
  });

  it("a recorded point's twin image focuses exactly where holo.ts predicts", () => {
    const xo = -40;
    const doDist = 2500;
    const t = composeTransmission(
      record([PT_REF, { source: { kind: "point", x: xo, z: -doDist, amp: 2 } }]),
      PT_ZONE,
    );
    const { twin } = holoImages(
      pointBeam(xo, doDist),
      planeBeam(PT_REF_DEG),
      planeBeam(PT_REF_DEG),
      1,
    );
    expect(twin.kind).toBe("real");
    // scan the predicted focal plane for the intensity peak
    const plan = planPropagation(playback(t, PT_REF), LAMBDA);
    const out = propagateTo(plan, twin.dist ?? 0);
    let bestI = 0;
    let bestX = 0;
    for (let i = 0; i < N; i++) {
      const p = out.re[i] ** 2 + out.im[i] ** 2;
      if (p > bestI) {
        bestI = p;
        bestX = X0 + i * DX;
      }
    }
    expect(twin.x).toBeDefined();
    // Paraxial prediction walks sinθ·d; the real beam walks tanθ·d (~9 µm more
    // at this tilt). Half a focal-spot width (λ·d/W ≈ 25 µm) is the honest bar.
    expect(Math.abs(bestX - (twin.x ?? 0))).toBeLessThan(15);
  });

  it("cut the film: an eye looking through a small strip still sees the point in place — dimmer and blurrier", () => {
    // The zero-order beam floods any fixed plane, so the honest instrument for
    // this claim is the direction-selective one — the eye, focused on the
    // virtual image (exactly how you actually look at a hologram). And the eye
    // only escapes the zero-order if the reference is steep enough that the
    // defocused zero-order patch lands outside the view — the design rule that
    // made Leith–Upatnieks off-axis holography work. 12° does it here; at 6°
    // the zero-order's blurred edge would still win over the image.
    // Bleached (phase) film: through a strip this small, an amplitude
    // hologram's ~6% image order loses to the zero-order's diffraction tails —
    // the bleach's ~34% is what makes tiny pieces actually viewable. (That
    // efficiency gap is itself one of the notebook's design lessons.) The 15°
    // reference keeps the defocused zero-order patch fully outside the view.
    const xo = -40;
    const doDist = 2500;
    const ref: ArmSpec = { source: { kind: "plane", angleDeg: 15, amp: 1 } };
    const full = composeTransmission(
      record([ref, { source: { kind: "point", x: xo, z: -doDist, amp: 5 } }], undefined, "phase"),
      PT_ZONE,
    );
    const cut = composeTransmission(full, apertureWindow(N, DX, X0, { center: 75, width: 120 }));

    const eye = {
      x: 100,
      standoff: 500,
      aperture: 350, // wide enough that the FULL film, not the pupil, sets the full-view sharpness
      focusDepth: 3000, // the virtual point: 2500 behind the film + 500 standoff
      viewHalfWidth: 400,
      nPupil: 256, // the lens phase at a 350 µm rim needs finer pupil sampling
    };
    const look = (t: Transmission) => retinaImage(playback(t, ref), LAMBDA, eye);
    // smoothed quarter-max width: boxcar the ripple away, then walk out from
    // the peak — a fixed-plane quantile would be baseline-dominated instead
    const measure = (
      img: ReturnType<typeof retinaImage>,
    ): { x: number; width: number; peak: number } => {
      const n = img.intensity.length;
      const s = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        let acc = 0;
        let c = 0;
        for (let j = Math.max(0, i - 5); j <= Math.min(n - 1, i + 5); j++) {
          acc += img.intensity[j];
          c++;
        }
        s[i] = acc / c;
      }
      let peak = 0;
      let bj = 0;
      for (let i = 0; i < n; i++)
        if (s[i] > peak) {
          peak = s[i];
          bj = i;
        }
      let lo = bj;
      let hi = bj;
      while (lo > 0 && s[lo] > peak / 4) lo--;
      while (hi < n - 1 && s[hi] > peak / 4) hi++;
      const step = Math.abs(img.xApparent[1] - img.xApparent[0]);
      return { x: img.xApparent[bj], width: (hi - lo) * step, peak };
    };

    const fullP = measure(look(full));
    const cutP = measure(look(cut));
    // every piece of the film knows where the point is… (the single-element
    // "eye" itself distorts ~15 µm this far off-axis)
    expect(Math.abs(fullP.x - xo)).toBeLessThan(40);
    expect(Math.abs(cutP.x - xo)).toBeLessThan(40);
    // …but the small strip is a smaller window: blurrier and dimmer, never "a corner of the scene"
    expect(cutP.width).toBeGreaterThan(fullP.width * 1.5);
    expect(cutP.peak).toBeLessThan(fullP.peak * 0.7);
  });
});

describe("the bench's failure modes (design constraints, not footnotes)", () => {
  it("arms mismatched beyond the coherence length leave no fringes", () => {
    const arm: ArmSpec = { source: { kind: "plane", angleDeg: 3, amp: 1 }, pathOffset: 4000 };
    const good = exposeFilm([REF, { ...arm, pathOffset: 0 }], N, DX, X0, 0, LAMBDA, {
      coherenceLength: 800,
    });
    const bad = exposeFilm([REF, arm], N, DX, X0, 0, LAMBDA, { coherenceLength: 800 });
    const swing = (e: Float64Array): number => {
      let mn = Number.POSITIVE_INFINITY;
      let mx = 0;
      for (let i = 512; i < 1536; i++) {
        mn = Math.min(mn, e[i]);
        mx = Math.max(mx, e[i]);
      }
      return (mx - mn) / (mx + mn);
    };
    expect(swing(good.exposure)).toBeGreaterThan(0.9);
    expect(swing(bad.exposure)).toBeLessThan(0.05);
    expect(bad.worstContrast).toBeLessThan(0.01);
  });

  it("λ/4 of bench vibration wipes most of the fringe contrast", () => {
    const obj: ArmSpec = { source: { kind: "plane", angleDeg: 3, amp: 1 } };
    const still = exposeFilm([REF, obj], N, DX, X0, 0, LAMBDA);
    const shaky = exposeFilm([REF, obj], N, DX, X0, 0, LAMBDA, { vibrationRms: 0.25 });
    expect(still.worstContrast).toBeCloseTo(1, 5);
    expect(shaky.worstContrast).toBeLessThan(0.35);
  });

  it("coarse emulsion erases fine fringes (steep reference angles need fine film)", () => {
    const t = record([REF, { source: { kind: "plane", angleDeg: 3, amp: 1 } }]);
    const sObj = Math.sin((3 * Math.PI) / 180);
    const before = powerInBand(farField(playback(t), LAMBDA, { raw: true }), sObj, 0.02);
    // fringe pitch here: λ/|sinθr − sinθo| ≈ 8/0.156 ≈ 51 µm; a 150 µm-grain film kills it
    const coarse = { ...t, re: t.re.slice(), im: t.im.slice() };
    lowpassTransmission(coarse, 150);
    const after = powerInBand(farField(playback(coarse), LAMBDA, { raw: true }), sObj, 0.02);
    expect(after).toBeLessThan(before * 0.1);
  });

  it("grain dots are deterministic and denser where the exposure is brighter", () => {
    const exp = exposeFilm(
      [REF, { source: { kind: "plane", angleDeg: 3, amp: 1 } }],
      256,
      6,
      -768,
      0,
      LAMBDA,
    );
    const a = grainDots(exp.exposure, exp.mean, { dx: 6, x0: -768 }, { count: 4000, seed: 7 });
    const b = grainDots(exp.exposure, exp.mean, { dx: 6, x0: -768 }, { count: 4000, seed: 7 });
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(1000);
    // census: bright fringes hold more grains than dark ones
    let bright = 0;
    let dark = 0;
    for (let i = 0; i < a.length; i += 2) {
      const idx = Math.min(255, Math.max(0, Math.floor((a[i] + 768) / 6)));
      if (exp.exposure[idx] > exp.mean) bright++;
      else dark++;
    }
    expect(bright).toBeGreaterThan(dark * 2);
  });
});

describe("holo.ts sanity (the designer's equations by themselves)", () => {
  it("matched playback reconstructs the point exactly where it was, M = 1", () => {
    const { image } = holoImages(pointBeam(-40, 400), planeBeam(12), planeBeam(12), 1);
    expect(image.kind).toBe("virtual");
    expect(image.x).toBeCloseTo(-40, 6);
    expect(image.dist).toBeCloseTo(400, 6);
    expect(image.magnification).toBeCloseTo(1, 6);
  });

  it("doubling the playback wavelength halves the image depth (λ-swap magnification)", () => {
    const { image } = holoImages(pointBeam(0, 400), planeBeam(12), planeBeam(12), 2);
    expect(image.kind).toBe("virtual");
    expect(image.dist).toBeCloseTo(200, 6);
  });

  it("record with a diverging reference, play back collimated → a ×3 magnified real projection", () => {
    const { image } = holoImages(pointBeam(0, 400), pointBeam(0, 300), planeBeam(0), 1);
    expect(image.kind).toBe("real");
    expect(image.dist).toBeCloseTo(1200, 4);
    expect(image.magnification).toBeCloseTo(3, 4);
  });

  it("an on-axis object's twin sits at twice the reference angle", () => {
    const { twin } = holoImages(planeBeam(0), planeBeam(10), planeBeam(10), 1);
    const s10 = Math.sin((10 * Math.PI) / 180);
    expect(twin.kind).toBe("collimated");
    expect(twin.tilt).toBeCloseTo(2 * s10, 6);
  });
});
