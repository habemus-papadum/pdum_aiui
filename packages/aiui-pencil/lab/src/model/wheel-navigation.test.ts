import type { PenSample } from "@habemus-papadum/aiui-pencil";
import { describe, expect, it } from "vitest";
import { mouseDraftCanYieldToPinch } from "./wheel-navigation";

const mouse: PenSample = {
  x: 10,
  y: 20,
  t: 0,
  kind: "mouse",
  pressure: 0.5,
  altitude: Math.PI / 2,
  azimuth: 0,
  twist: 0,
  width: 1,
  height: 1,
};

describe("mouse draft handoff to pinch", () => {
  it("permits ordinary mouse data, including zero pressure and view-rotated azimuth", () => {
    expect(mouseDraftCanYieldToPinch({ points: [mouse, { ...mouse, pressure: 0 }] })).toBe(true);
    expect(mouseDraftCanYieldToPinch({ points: [{ ...mouse, azimuth: 1 }] })).toBe(true);
    expect(mouseDraftCanYieldToPinch({ points: [] })).toBe(false);
  });

  it.each<Partial<PenSample>>([
    { kind: "pen" },
    { kind: "touch" },
    { pressure: 0.501960813999176 },
    { pressure: 0.1 },
    { altitude: Math.PI / 3 },
    { twist: 45 },
  ])("retains earlier pen evidence even when the latest sample looks ordinary: %j", (evidence) => {
    expect(mouseDraftCanYieldToPinch({ points: [mouse, { ...mouse, ...evidence }, mouse] })).toBe(
      false,
    );
  });
});
