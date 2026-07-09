import { describe, expect, it } from "vitest";
import { areaHistogram, autocorrelationAtLag, dominantWavelength, labelComponents } from "./core";

function fieldOf(rows: string[]): { field: Float32Array; width: number; height: number } {
  const height = rows.length;
  const width = rows[0].length;
  const field = new Float32Array(width * height);
  rows.forEach((row, y) => {
    for (let x = 0; x < width; x++) field[y * width + x] = row[x] === "#" ? 1 : 0;
  });
  return { field, width, height };
}

describe("labelComponents", () => {
  it("counts two spots that touch only diagonally as separate (4-connectivity)", () => {
    const { field, width, height } = fieldOf([
      "##..", //
      "##..",
      "..##",
      "..##",
    ]);
    const census = labelComponents(field, width, height, 0.5);
    expect(census.count).toBe(2);
    expect(census.areas).toEqual([4, 4]);
    expect(census.meanArea).toBe(4);
  });

  it("merges an L-shaped component discovered under two provisional labels", () => {
    const { field, width, height } = fieldOf([
      "#.#", //
      "###",
      "...",
    ]);
    const census = labelComponents(field, width, height, 0.5);
    expect(census.count).toBe(1);
    expect(census.areas).toEqual([5]);
  });

  it("returns an empty census below threshold", () => {
    const { field, width, height } = fieldOf(["...", "...", "..."]);
    const census = labelComponents(field, width, height, 0.5);
    expect(census.count).toBe(0);
    expect(census.meanArea).toBe(0);
    expect(census.largestFraction).toBe(0);
  });
});

describe("areaHistogram", () => {
  it("bins every component and preserves the total count", () => {
    const areas = [64, 60, 58, 12, 11, 9, 3, 2, 1];
    const bins = areaHistogram(areas, 6);
    expect(bins.reduce((s, b) => s + b.count, 0)).toBe(areas.length);
  });

  it("is empty for no components", () => {
    expect(areaHistogram([])).toEqual([]);
  });
});

describe("autocorrelation / dominant wavelength", () => {
  it("finds the period of a striped field", () => {
    const width = 64;
    const height = 64;
    const period = 8;
    const field = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        field[y * width + x] = x % period < period / 2 ? 1 : 0;
      }
    }
    let mean = 0;
    for (const v of field) mean += v;
    mean /= field.length;
    const correlogram: number[] = [];
    for (let lag = 1; lag <= 24; lag++) {
      correlogram.push(autocorrelationAtLag(field, width, height, mean, lag));
    }
    expect(dominantWavelength(correlogram)).toBe(period);
  });

  it("returns undefined when nothing stands out", () => {
    // Monotonically decaying correlogram with no positive recurrence.
    const correlogram = Array.from({ length: 20 }, (_, i) => 0.8 * Math.exp(-i) - 0.05);
    expect(dominantWavelength(correlogram)).toBeUndefined();
  });
});
