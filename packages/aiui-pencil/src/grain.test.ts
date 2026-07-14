import { describe, expect, it } from "vitest";
import { noiseField } from "./grain";

describe("noiseField — the paper's tooth", () => {
  it("is deterministic: the same seed is the same paper", () => {
    const a = noiseField(64, 8, 7);
    const b = noiseField(64, 8, 7);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("is different paper for a different seed", () => {
    const a = noiseField(64, 8, 1);
    const b = noiseField(64, 8, 2);
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it("spans the full 0..1 range, so the grain knob means the same thing every time", () => {
    const field = noiseField(64, 8, 3);
    expect(Math.min(...field)).toBeCloseTo(0, 6);
    expect(Math.max(...field)).toBeCloseTo(1, 6);
  });

  it("TILES SEAMLESSLY — the one property a repeating pattern cannot do without", () => {
    // The texture is repeated across the whole page. A seam would not be a
    // subtle artifact: it would be a visible grid of straight lines running
    // through every stroke on the canvas. Wrapping the lattice is what prevents
    // it, so the last column must continue smoothly into the first.
    const size = 64;
    const field = noiseField(size, 8, 5);
    const at = (x: number, y: number): number => field[y * size + x];

    let worstSeam = 0;
    let worstInterior = 0;
    for (let y = 0; y < size; y++) {
      // The wrap: last column → first column.
      worstSeam = Math.max(worstSeam, Math.abs(at(size - 1, y) - at(0, y)));
      // A typical interior step, for comparison — the seam must be no worse.
      worstInterior = Math.max(worstInterior, Math.abs(at(size - 2, y) - at(size - 1, y)));
    }
    expect(worstSeam).toBeLessThanOrEqual(worstInterior * 3);
    expect(worstSeam).toBeLessThan(0.2);
  });

  it("tiles vertically too", () => {
    const size = 64;
    const field = noiseField(size, 8, 5);
    const at = (x: number, y: number): number => field[y * size + x];
    let worstSeam = 0;
    for (let x = 0; x < size; x++) {
      worstSeam = Math.max(worstSeam, Math.abs(at(x, size - 1) - at(x, 0)));
    }
    expect(worstSeam).toBeLessThan(0.2);
  });

  it("actually varies — a flat field would be no tooth at all", () => {
    const field = noiseField(64, 8, 11);
    const mean = field.reduce((a, b) => a + b, 0) / field.length;
    const variance = field.reduce((a, b) => a + (b - mean) ** 2, 0) / field.length;
    expect(variance).toBeGreaterThan(0.01);
  });
});
