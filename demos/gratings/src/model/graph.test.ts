/**
 * graph.test.ts — headless probes of the inline cells: one probe per input
 * per cell (the instrument that catches an undeclared dependency). The
 * worker-backed map cells hold in jsdom (no Worker) by design; their request
 * builders are covered in bench.test.ts.
 */
import { cellHarness, resetControlSurface, whenReady } from "@habemus-papadum/aiui-viz/testing";
import { afterEach, expect, it } from "vitest";
import { graph } from "./graph";
import {
  incidentDeg,
  lambda,
  nSlits,
  objDist,
  pitch,
  probeX,
  probeZ,
  srcSep,
  zoneF,
} from "./store";

afterEach(() => resetControlSurface());

it("benchNumbers tracks λ, Λ, N, and the incident angle", async () => {
  const h = cellHarness(() => graph());
  try {
    const v0 = await whenReady(h.cells.benchNumbers);
    expect(v0.kick).toBeCloseTo(8 / 40, 6);

    lambda.set(10);
    expect((await whenReady(h.cells.benchNumbers)).kick).toBeCloseTo(10 / 40, 6);

    pitch.set(50);
    expect((await whenReady(h.cells.benchNumbers)).kick).toBeCloseTo(10 / 50, 6);

    nSlits.set(10);
    expect((await whenReady(h.cells.benchNumbers)).resolve).toBe(10);

    incidentDeg.set(6);
    const sIn = Math.sin((6 * Math.PI) / 180);
    expect((await whenReady(h.cells.benchNumbers)).orders.find((o) => o.m === 0)?.sin).toBeCloseTo(
      sIn,
      6,
    );
  } finally {
    h.dispose();
  }
});

it("slitFar recomputes when each input moves, and peaks at the predicted order", async () => {
  const h = cellHarness(() => graph());
  try {
    const v0 = await whenReady(h.cells.slitFar);
    // the m=+1 order's angular bin should carry near-peak power
    const m1 = v0.orders.find((o) => o.m === 1);
    expect(m1).toBeDefined();
    let best = 0;
    let bestSin = 0;
    for (let i = 0; i < v0.sin.length; i++) {
      if (v0.power[i] > best && Math.abs(v0.sin[i]) > 0.05) {
        best = v0.power[i];
        bestSin = v0.sin[i];
      }
    }
    expect(Math.abs(Math.abs(bestSin) - (m1?.sin ?? 0))).toBeLessThan(0.02);

    lambda.set(12);
    expect((await whenReady(h.cells.slitFar)).orders.find((o) => o.m === 1)?.sin).toBeCloseTo(
      12 / 40,
      6,
    );
    pitch.set(60);
    expect((await whenReady(h.cells.slitFar)).orders.find((o) => o.m === 1)?.sin).toBeCloseTo(
      12 / 60,
      6,
    );
    nSlits.set(4);
    await whenReady(h.cells.slitFar);
    incidentDeg.set(-4);
    const shifted = await whenReady(h.cells.slitFar);
    expect(shifted.orders.find((o) => o.m === 0)?.sin).toBeCloseTo(
      Math.sin((-4 * Math.PI) / 180),
      6,
    );
  } finally {
    h.dispose();
  }
});

it("screenLine moves with λ and d (fringe spacing λL/d)", async () => {
  const h = cellHarness(() => graph());
  try {
    const spacingOf = (data: Float64Array): number => {
      // count maxima in the central half (threshold relative to the peak)
      let max = 0;
      for (const v of data) max = Math.max(max, v);
      let peaks = 0;
      for (let i = 200; i < 460; i++) {
        if (data[i] > data[i - 1] && data[i] >= data[i + 1] && data[i] > 0.3 * max) peaks++;
      }
      return 260 / Math.max(1, peaks);
    };
    const s0 = spacingOf((await whenReady(h.cells.screenLine)).data);
    srcSep.set(180); // double d → half spacing
    const s1 = spacingOf((await whenReady(h.cells.screenLine)).data);
    expect(s1).toBeLessThan(s0 * 0.75);
    lambda.set(12);
    const s2 = spacingOf((await whenReady(h.cells.screenLine)).data);
    expect(s2).toBeGreaterThan(s1);
  } finally {
    h.dispose();
  }
});

it("probeArrows: two arrows whose relative angle moves with every input", async () => {
  const h = cellHarness(() => graph());
  try {
    const angleBetween = (v: { arrows: { re: number; im: number }[] }): number => {
      const [a, b] = v.arrows;
      return Math.atan2(a.im, a.re) - Math.atan2(b.im, b.re);
    };
    const a0 = angleBetween(await whenReady(h.cells.probeArrows));
    probeX.set(150);
    const a1 = angleBetween(await whenReady(h.cells.probeArrows));
    expect(a1).not.toBeCloseTo(a0, 3);
    probeZ.set(200);
    const a2 = angleBetween(await whenReady(h.cells.probeArrows));
    expect(a2).not.toBeCloseTo(a1, 3);
    srcSep.set(60);
    const a3 = angleBetween(await whenReady(h.cells.probeArrows));
    expect(a3).not.toBeCloseTo(a2, 3);
    lambda.set(6);
    const a4 = angleBetween(await whenReady(h.cells.probeArrows));
    expect(a4).not.toBeCloseTo(a3, 3);
  } finally {
    h.dispose();
  }
});

it("slitArrows lock on an order direction and coil off it; every input declared", async () => {
  const h = cellHarness(() => graph());
  try {
    const resultant = (v: { arrows: { re: number; im: number }[] }): number => {
      let sr = 0;
      let si = 0;
      for (const a of v.arrows) {
        sr += a.re;
        si += a.im;
      }
      return Math.hypot(sr, si) / v.arrows.length;
    };
    // aim the probe along m=+1: sinθ = λ/Λ = 0.2
    const z = 500;
    const sin1 = 8 / 40;
    probeZ.set(z);
    probeX.set(Math.round((sin1 / Math.sqrt(1 - sin1 * sin1)) * z));
    const locked = await whenReady(h.cells.slitArrows);
    expect(locked.arrows).toHaveLength(24);
    expect(resultant(locked)).toBeGreaterThan(0.95);
    // between orders: the spiral closes
    probeX.set(Math.round((0.1 / Math.sqrt(1 - 0.01)) * z));
    expect(resultant(await whenReady(h.cells.slitArrows))).toBeLessThan(0.3);
    // the other inputs are declared deps
    nSlits.set(8);
    expect((await whenReady(h.cells.slitArrows)).arrows).toHaveLength(8);
    pitch.set(80);
    await whenReady(h.cells.slitArrows);
    lambda.set(10);
    await whenReady(h.cells.slitArrows);
  } finally {
    h.dispose();
  }
});

it("spectroChart: fan and R follow Λ and N; overlap flagged for this band", async () => {
  const h = cellHarness(() => graph());
  try {
    const v0 = await whenReady(h.cells.spectroChart);
    expect(v0.series.length).toBe(6);
    expect(v0.overlap).toBe(true); // 2×4.8 < 13
    expect(v0.resolve).toBe(24);
    nSlits.set(12);
    expect((await whenReady(h.cells.spectroChart)).resolve).toBe(12);
    pitch.set(80);
    const v1 = await whenReady(h.cells.spectroChart);
    expect(v1.fan.from).toBeLessThan(v0.fan.from); // coarser pitch → narrower fan
  } finally {
    h.dispose();
  }
});

it("lensNumbers follows the lens law over f, zo, xo, λ", async () => {
  const h = cellHarness(() => graph());
  try {
    const v0 = await whenReady(h.cells.lensNumbers);
    expect(v0.kind).toBe("real");
    expect(1 / v0.imageDist + 1 / 600).toBeCloseTo(1 / 380, 9);

    zoneF.set(300);
    expect((await whenReady(h.cells.lensNumbers)).imageDist).toBeCloseTo(600, 4);

    objDist.set(450);
    expect(1 / (await whenReady(h.cells.lensNumbers)).imageDist + 1 / 450).toBeCloseTo(1 / 300, 9);

    const before = (await whenReady(h.cells.lensNumbers)).imageX;
    const { objX } = await import("./store");
    objX.set(40);
    expect((await whenReady(h.cells.lensNumbers)).imageX).not.toBeCloseTo(before, 6);

    lambda.set(10);
    const v1 = await whenReady(h.cells.lensNumbers);
    expect(v1.fRed).toBeCloseTo((300 * 10) / 12, 4);
  } finally {
    h.dispose();
  }
});
