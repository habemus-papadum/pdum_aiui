/**
 * graph.test.ts — headless probes of the inline cells: one probe per input
 * per cell. The worker-backed map cells hold in jsdom (no Worker) by design;
 * their request builders are covered in bench.test.ts.
 */
import { cellHarness, resetControlSurface, whenReady } from "@habemus-papadum/aiui-viz/testing";
import { afterEach, expect, it } from "vitest";
import { graph } from "./graph";
import {
  bleach,
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
  scenePoints,
  vibration,
  windowWidth,
} from "./store";

afterEach(() => {
  resetControlSurface();
  // scenePoints is a durable, not a control — restore it by hand
  scenePoints.set([
    { x: -70, z: -560 },
    { x: 15, z: -760 },
    { x: 80, z: -1000 },
  ]);
});

it("exposure tracks every bench input", async () => {
  const h = cellHarness(() => graph());
  try {
    const v0 = await whenReady(h.cells.exposure);
    expect(v0.worstContrast).toBeGreaterThan(0.8);

    vibration.set(0.4);
    expect((await whenReady(h.cells.exposure)).worstContrast).toBeLessThan(0.1);
    vibration.set(0);

    pathTrim.set(-4000);
    coherenceLen.set(800);
    expect((await whenReady(h.cells.exposure)).worstContrast).toBeLessThan(0.05);
    pathTrim.set(0);
    coherenceLen.set(3000);

    const m0 = (await whenReady(h.cells.exposure)).mean;
    objGain.set(8);
    expect((await whenReady(h.cells.exposure)).mean).toBeGreaterThan(m0);

    lambdaRec.set(10);
    await whenReady(h.cells.exposure);
    refAngleDeg.set(10);
    await whenReady(h.cells.exposure);
    scenePoints.set([{ x: 0, z: -700 }]);
    await whenReady(h.cells.exposure);
  } finally {
    h.dispose();
  }
});

it("developed responds to the darkroom knobs; cut responds to the scissors", async () => {
  const h = cellHarness(() => graph());
  try {
    const d0 = await whenReady(h.cells.developed);
    expect(d0.bleached).toBe(true);

    bleach.set(false);
    const d1 = await whenReady(h.cells.developed);
    expect(d1.bleached).toBe(false);

    gamma.set(0.4);
    await whenReady(h.cells.developed);
    filmRes.set(80);
    await whenReady(h.cells.developed);

    const c0 = await whenReady(h.cells.cut);
    // full width: untouched film (same instance)
    expect(c0.t).toBe((await whenReady(h.cells.developed)).t);
    windowWidth.set(200);
    const c1 = await whenReady(h.cells.cut);
    expect(c1.t).not.toBe((await whenReady(h.cells.developed)).t);
    // the window really cuts: edges dark
    expect(Math.hypot(c1.t.re[10], c1.t.im[10])).toBe(0);
  } finally {
    h.dispose();
  }
});

it("benchNumbers flags a too-coarse emulsion", async () => {
  const h = cellHarness(() => graph());
  try {
    expect((await whenReady(h.cells.benchNumbers)).filmOk).toBe(true);
    filmRes.set(60);
    expect((await whenReady(h.cells.benchNumbers)).filmOk).toBe(false);
    filmRes.set(4);
    const f22 = (await whenReady(h.cells.benchNumbers)).finest;
    refAngleDeg.set(10);
    const v = await whenReady(h.cells.benchNumbers);
    expect(v.finest).toBeGreaterThan(f22); // gentler reference → coarser fringes
  } finally {
    h.dispose();
  }
});

it("split: bleaching multiplies the image share; µ and angle are declared deps", async () => {
  const h = cellHarness(() => graph());
  try {
    const p0 = await whenReady(h.cells.split);
    bleach.set(false);
    const p1 = await whenReady(h.cells.split);
    expect(p0.image).toBeGreaterThan(p1.image * 2.5);
    playScale.set(1.2);
    await whenReady(h.cells.split);
    playAngleDeg.set(10);
    await whenReady(h.cells.split);
    playAngleDeg.set(22);
    playScale.set(1);
    bleach.set(true);
    const full = await whenReady(h.cells.split);
    windowWidth.set(240);
    // the robust "smaller window = dimmer image" claim: the far-field image
    // band integrates away the speckle the retina view carries
    expect((await whenReady(h.cells.split)).image).toBeLessThan(full.image * 0.7);
  } finally {
    h.dispose();
  }
});

it("ghosts: matched playback lands on the points; µ pulls them in", async () => {
  const h = cellHarness(() => graph());
  try {
    const g0 = await whenReady(h.cells.ghosts);
    expect(g0[0].image.x).toBeCloseTo(-70, 3);
    expect(g0[0].image.z).toBeCloseTo(-560, 3);
    playScale.set(1.4);
    const g1 = await whenReady(h.cells.ghosts);
    expect(-(g1[0].image.z ?? 0)).toBeCloseTo(560 / 1.4, 2);
    playAngleDeg.set(10);
    const g2 = await whenReady(h.cells.ghosts);
    expect(g2[0].image.x).not.toBeCloseTo(g1[0].image.x ?? 0, 1);
  } finally {
    h.dispose();
  }
});

it("eyeView responds to the rail, the focus, and the window", async () => {
  const h = cellHarness(() => graph());
  try {
    const peakX = (v: { xApparent: Float64Array; intensity: Float64Array }): number => {
      let b = 0;
      let x = 0;
      for (let i = 0; i < v.intensity.length; i++) {
        if (v.intensity[i] > b) {
          b = v.intensity[i];
          x = v.xApparent[i];
        }
      }
      return x;
    };
    const v0 = await whenReady(h.cells.eyeView);
    expect(v0.peak).toBeGreaterThan(0);

    const localPeak = (
      v: { xApparent: Float64Array; intensity: Float64Array },
      center: number,
      half: number,
    ): number => {
      let b = 0;
      for (let i = 0; i < v.intensity.length; i++) {
        if (Math.abs(v.xApparent[i] - center) <= half && v.intensity[i] > b) b = v.intensity[i];
      }
      return b;
    };
    eyeX.set(100);
    const v1 = await whenReady(h.cells.eyeView);
    // the in-focus point's peak survives the eye moving (parallax-consistent)
    expect(localPeak(v1, 15, 50)).toBeGreaterThan(0);
    expect(Math.abs(peakX(v1) - peakX(v0))).toBeLessThan(220);

    eyeX.set(0);
    eyeFocus.set(900);
    await whenReady(h.cells.eyeView);
    eyeFocus.set(1300);
    const vBase = await whenReady(h.cells.eyeView);
    windowWidth.set(240);
    const v3 = await whenReady(h.cells.eyeView);
    // dep coverage: the window visibly changes the view (the magnitude claim
    // lives on the split cell — retina peaks carry glare + speckle)
    expect(v3.peak).not.toBeCloseTo(vBase.peak, 6);
    playScale.set(1.3);
    await whenReady(h.cells.eyeView);
  } finally {
    h.dispose();
  }
});
