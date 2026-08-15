/**
 * graph.test.ts — the wiring probe (house style: poke every control a cell
 * claims to depend on and watch the value move), plus the one cross-slide
 * claim the talk makes on stage: the pressure angle moved inside a Lens
 * reshapes the SAME cells every figure reads.
 */
import { cellHarness, resetControlSurface, whenReady } from "@habemus-papadum/aiui-viz/testing";
import { afterEach, expect, it } from "vitest";
import { graph } from "./graph";
import { pressureAngle, teethA, teethB } from "./store";

afterEach(() => resetControlSurface());

it("teeth controls drive the pair and the mesh readouts", async () => {
  const h = cellHarness(() => graph());
  try {
    teethA.set(12);
    teethB.set(24);
    const scene = await whenReady(h.cells.scene);
    expect(scene.a.params.teeth).toBe(12);
    expect(scene.b.params.teeth).toBe(24);
    expect(scene.mesh.ratio).toBeCloseTo(2, 5);
  } finally {
    h.dispose();
  }
});

it("the pressure angle (the Lens slider's control) reshapes the shared cells", async () => {
  const h = cellHarness(() => graph());
  try {
    pressureAngle.set(20);
    const before = await whenReady(h.cells.mesh);
    pressureAngle.set(25);
    const after = await whenReady(h.cells.mesh);
    expect(after.basePitch).not.toBeCloseTo(before.basePitch, 5);
    // r_b = r·cos φ — a bigger φ means a smaller base circle
    const gearAfter = await whenReady(h.cells.gearA);
    expect(gearAfter.baseRadius).toBeCloseTo(
      gearAfter.pitchRadius * Math.cos((25 * Math.PI) / 180),
      6,
    );
  } finally {
    h.dispose();
  }
});
