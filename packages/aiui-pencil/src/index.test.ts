import { describe, expect, it } from "vitest";
import { name, pencilPreset, planStroke, SKETCH, WRITE } from "./index";
import type { PenSample } from "./telemetry";

describe("the barrel", () => {
  it("exports the package name", () => {
    expect(name).toBe("@habemus-papadum/aiui-pencil");
  });

  it("runs a stroke end to end through the public surface", () => {
    const raw: PenSample[] = Array.from({ length: 12 }, (_, i) => ({
      x: i * 4,
      y: Math.sin(i / 3) * 6,
      t: i * 8,
      pressure: 0.6,
      altitude: Math.PI / 2,
      azimuth: 0,
      twist: 0,
      kind: "pen" as const,
      width: 1,
      height: 1,
    }));
    const plan = planStroke(raw, pencilPreset("write"));
    expect(plan.dabs.length).toBeGreaterThan(raw.length);
    expect(plan.dabs.every((d) => d.alpha > 0 && d.alpha <= 1)).toBe(true);
  });
});

describe("the presets differ where the design says they differ", () => {
  it("writing is more responsive; sketching is more streamlined", () => {
    expect(WRITE.filter.beta).toBeGreaterThan(SKETCH.filter.beta);
    expect(WRITE.filter.minCutoff).toBeGreaterThan(SKETCH.filter.minCutoff);
  });

  it("writing keeps corners a sketch would smooth through", () => {
    expect(WRITE.cuspThreshold).toBeLessThan(SKETCH.cuspThreshold);
    expect(WRITE.cuspWindow).toBeLessThan(SKETCH.cuspWindow);
  });

  it("sketching engages tilt and paper tooth; writing mostly does not", () => {
    expect(SKETCH.tiltToEccentricity).toBeGreaterThan(WRITE.tiltToEccentricity);
    expect(SKETCH.grain).toBeGreaterThan(WRITE.grain);
  });
});
