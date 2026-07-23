import { cellHarness, resetControlSurface, whenReady } from "@habemus-papadum/aiui-viz/testing";
import { afterEach, expect, it } from "vitest";
import { graph } from "./graph";
import { addendum, module, pressureAngle, teethA, teethB } from "./store";

afterEach(() => resetControlSurface());

it("gearA rebuilds when teethA moves", async () => {
  const h = cellHarness(() => graph());
  try {
    const g0 = await whenReady(h.cells.gearA);
    expect(g0.params.teeth).toBe(teethA.initial);
    teethA.set(30);
    const g1 = await whenReady(h.cells.gearA);
    expect(g1.params.teeth).toBe(30);
    expect(g1.pitchRadius).toBeGreaterThan(g0.pitchRadius);
  } finally {
    h.dispose();
  }
});

it("gearA responds to module, pressure angle and addendum (deps are declared)", async () => {
  const h = cellHarness(() => graph());
  try {
    await whenReady(h.cells.gearA);

    module.set(12);
    expect((await whenReady(h.cells.gearA)).params.module).toBe(12);

    pressureAngle.set(25);
    expect((await whenReady(h.cells.gearA)).params.pressureAngle).toBe(25);

    addendum.set(1.3);
    expect((await whenReady(h.cells.gearA)).params.addendum).toBeCloseTo(1.3, 6);
  } finally {
    h.dispose();
  }
});

it("gearB tracks teethB independently of gearA", async () => {
  const h = cellHarness(() => graph());
  try {
    await whenReady(h.cells.gearB);
    teethB.set(15);
    const b = await whenReady(h.cells.gearB);
    expect(b.params.teeth).toBe(15);
    // gearA untouched
    expect((await whenReady(h.cells.gearA)).params.teeth).toBe(teethA.initial);
  } finally {
    h.dispose();
  }
});

it("mesh recomputes centre distance and ratio when either gear changes", async () => {
  const h = cellHarness(() => graph());
  try {
    const m0 = await whenReady(h.cells.mesh);
    const c0 = m0.center;
    teethB.set(34);
    const m1 = await whenReady(h.cells.mesh);
    expect(m1.center).toBeGreaterThan(c0);
    expect(m1.ratio).toBeCloseTo(34 / teethA.initial, 6);
  } finally {
    h.dispose();
  }
});

it("scene bundles both gears and the mesh together", async () => {
  const h = cellHarness(() => graph());
  try {
    const s = await whenReady(h.cells.scene);
    expect(s.a.params.teeth).toBe(teethA.initial);
    expect(s.b.params.teeth).toBe(teethB.initial);
    expect(s.mesh.center).toBeCloseTo(s.a.pitchRadius + s.b.pitchRadius, 6);
  } finally {
    h.dispose();
  }
});
