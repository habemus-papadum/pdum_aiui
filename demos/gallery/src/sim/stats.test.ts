import { describe, expect, it } from "vitest";
import { computeFieldStats } from "./stats";

/** Build an RGBA readback buffer from per-pixel (u, v) in 0..1. */
function field(width: number, height: number, uv: (x: number, y: number) => [number, number]) {
  const bytes = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [u, v] = uv(x, y);
      const i = (y * width + x) * 4;
      bytes[i] = Math.round(u * 255);
      bytes[i + 1] = Math.round(v * 255);
    }
  }
  return bytes;
}

describe("computeFieldStats", () => {
  it("reports zero coverage and contrast for a uniform field", () => {
    const stats = computeFieldStats(
      field(16, 16, () => [1, 0]),
      16,
      16,
    );
    expect(stats.coverage).toBe(0);
    expect(stats.meanU).toBeCloseTo(1, 2);
    expect(stats.meanV).toBe(0);
    expect(stats.contrast).toBe(0);
  });

  it("measures a half-covered field", () => {
    const stats = computeFieldStats(
      field(16, 16, (x) => (x < 8 ? [0, 1] : [1, 0])),
      16,
      16,
    );
    expect(stats.coverage).toBeCloseTo(0.5, 2);
    expect(stats.meanV).toBeCloseTo(0.5, 2);
    // Two-valued field: sd = 0.5 exactly.
    expect(stats.contrast).toBeCloseTo(0.5, 2);
  });
});
