import { cellHarness, resetControlSurface, whenReady } from "@habemus-papadum/aiui-viz/testing";
import { afterEach, expect, it } from "vitest";
import { graph } from "./graph";
import {
  degree,
  dieRolls,
  heterogeneous,
  loadedness,
  members,
  noise,
  perturbation,
  samples,
  seed,
  smoothness,
  trainTime,
} from "./store";

afterEach(() => resetControlSurface());

it("die responds to loadedness and roll count", async () => {
  const h = cellHarness(() => graph());
  try {
    const d0 = await whenReady(h.cells.die);
    expect(d0.run.rolls).toHaveLength(dieRolls.initial);
    expect(d0.entropy).toBeGreaterThan(2);

    loadedness.set(1);
    const d1 = await whenReady(h.cells.die);
    expect(d1.entropy).toBeCloseTo(0, 9);
    expect(d1.pointwiseFloor).toBeCloseTo(0, 9);

    dieRolls.set(300);
    expect((await whenReady(h.cells.die)).run.rolls).toHaveLength(300);
  } finally {
    h.dispose();
  }
});

it("decomp responds to degree, samples, and noise", async () => {
  const h = cellHarness(() => graph());
  try {
    const d0 = await whenReady(h.cells.decomp);
    expect(d0.floor).toBeCloseTo(noise.initial ** 2, 9);

    degree.set(2);
    const d1 = await whenReady(h.cells.decomp);
    expect(d1.approximation).toBeGreaterThan(d0.approximation);

    samples.set(400);
    const d2 = await whenReady(h.cells.decomp);
    expect(d2.estimation).toBeLessThan(d1.estimation);

    noise.set(0.1);
    expect((await whenReady(h.cells.decomp)).floor).toBeCloseTo(0.01, 9);
  } finally {
    h.dispose();
  }
});

it("world redraws with the seed (reseed path)", async () => {
  const h = cellHarness(() => graph());
  try {
    const w0 = await whenReady(h.cells.world);
    seed.set(seed.get() + 1);
    const w1 = await whenReady(h.cells.world);
    expect(w1.data.ys[0]).not.toBe(w0.data.ys[0]);
  } finally {
    h.dispose();
  }
});

it("ens responds to members and heterogeneity", async () => {
  const h = cellHarness(() => graph());
  try {
    expect((await whenReady(h.cells.ens)).mseByM).toHaveLength(members.initial);
    members.set(4);
    expect((await whenReady(h.cells.ens)).mseByM).toHaveLength(4);
    heterogeneous.set(true);
    const e = await whenReady(h.cells.ens);
    expect(e.mseByM).toHaveLength(4);
    expect(e.disagreement).toBeGreaterThan(0);
  } finally {
    h.dispose();
  }
});

it("spectral scrubs with training time and smoothness", async () => {
  const h = cellHarness(() => graph());
  try {
    trainTime.set(-1);
    const s0 = await whenReady(h.cells.spectral);
    trainTime.set(4);
    const s1 = await whenReady(h.cells.spectral);
    expect(s1.state.loss).toBeLessThan(s0.state.loss);

    smoothness.set(0);
    const s2 = await whenReady(h.cells.spectral);
    expect(s2.state.target.every((a) => a === 1)).toBe(true);
  } finally {
    h.dispose();
  }
});

it("chaos responds to the perturbation exponent", async () => {
  const h = cellHarness(() => graph());
  try {
    perturbation.set(-3);
    const wide = await whenReady(h.cells.chaos);
    perturbation.set(-10);
    const narrow = await whenReady(h.cells.chaos);
    expect(narrow.div.horizonSteps).toBeGreaterThan(wide.div.horizonSteps);
    expect(narrow.inv.centers).toHaveLength(48);
  } finally {
    h.dispose();
  }
});
