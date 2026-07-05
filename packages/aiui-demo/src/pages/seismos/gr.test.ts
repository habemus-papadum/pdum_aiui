import { describe, expect, it } from "vitest";
import { bValue, cumulative, fitLine, type MagBin, mcMaxCurvature, totalCount } from "./gr";

describe("cumulative", () => {
  it("sums each bin and all higher bins, ascending", () => {
    const bins: MagBin[] = [
      { mag: 4.5, count: 100 },
      { mag: 4.6, count: 50 },
      { mag: 4.7, count: 25 },
    ];
    expect(cumulative(bins)).toEqual([
      { mag: 4.5, n: 175 },
      { mag: 4.6, n: 75 },
      { mag: 4.7, n: 25 },
    ]);
  });

  it("sorts unsorted input and drops empty bins", () => {
    const bins: MagBin[] = [
      { mag: 5.0, count: 2 },
      { mag: 4.5, count: 8 },
      { mag: 4.8, count: 0 },
    ];
    expect(cumulative(bins)).toEqual([
      { mag: 4.5, n: 10 },
      { mag: 5.0, n: 2 },
    ]);
  });
});

describe("totalCount", () => {
  it("adds all bin counts", () => {
    expect(
      totalCount([
        { mag: 4, count: 3 },
        { mag: 5, count: 7 },
      ]),
    ).toBe(10);
  });
});

describe("mcMaxCurvature", () => {
  it("returns the magnitude of the modal (peak) incremental bin", () => {
    const bins: MagBin[] = [
      { mag: 4.4, count: 20 },
      { mag: 4.7, count: 95 }, // peak — detection is highest just above roll-off
      { mag: 5.0, count: 40 },
    ];
    expect(mcMaxCurvature(bins)).toBe(4.7);
  });

  it("returns null for an empty histogram", () => {
    expect(mcMaxCurvature([])).toBeNull();
    expect(mcMaxCurvature([{ mag: 5, count: 0 }])).toBeNull();
  });
});

describe("bValue", () => {
  it("matches the closed-form Aki–Utsu estimate on a tiny histogram", () => {
    // Two complete bins at Mc = 4.5; mean is known exactly.
    const bins: MagBin[] = [
      { mag: 4.5, count: 30 },
      { mag: 4.6, count: 10 },
    ];
    const mc = 4.5;
    const dM = 0.1;
    const meanMag = (4.5 * 30 + 4.6 * 10) / 40;
    const expectedB = Math.LOG10E / (meanMag - (mc - dM / 2));
    const fit = bValue(bins, mc, dM);
    expect(fit).not.toBeNull();
    expect(fit?.meanMag).toBeCloseTo(meanMag, 10);
    expect(fit?.b).toBeCloseTo(expectedB, 10);
    expect(fit?.nComplete).toBe(40);
    // a-value anchors the line at N(≥Mc): 10^(a − b·Mc) == nComplete.
    if (fit) expect(10 ** (fit.a - fit.b * mc)).toBeCloseTo(40, 6);
  });

  it("recovers a known b-value from a synthetic exponential catalog", () => {
    // Build a geometric incremental FMD with true b = 1.0 above Mc = 4.5:
    // count(M) ∝ 10^(−b·(M−Mc)). Bender's correction should recover b within ~2%.
    const bTrue = 1.0;
    const mc = 4.5;
    const dM = 0.1;
    const base = 2_000_000;
    const bins: MagBin[] = [];
    for (let k = 0; k <= 35; k++) {
      const mag = Number((mc + k * dM).toFixed(1));
      bins.push({ mag, count: Math.round(base * 10 ** (-bTrue * (mag - mc))) });
    }
    const fit = bValue(bins, mc, dM);
    expect(fit).not.toBeNull();
    expect(fit?.b).toBeCloseTo(bTrue, 1); // within 0.05
    // Uncertainty on a 2M+-event sample is tiny.
    expect(fit?.sigmaB).toBeLessThan(0.01);
  });

  it("only counts events at or above Mc", () => {
    const bins: MagBin[] = [
      { mag: 4.0, count: 999 }, // below Mc — ignored (incomplete)
      { mag: 4.5, count: 40 },
      { mag: 4.6, count: 10 },
    ];
    const fit = bValue(bins, 4.5, 0.1);
    expect(fit?.nComplete).toBe(50);
  });

  it("returns null when fewer than two complete events remain", () => {
    expect(bValue([{ mag: 6, count: 1 }], 4.5)).toBeNull();
    expect(bValue([], 4.5)).toBeNull();
  });
});

describe("fitLine", () => {
  it("returns endpoints on the line N = 10^(a − b·M)", () => {
    const fit = bValue(
      [
        { mag: 4.5, count: 100 },
        { mag: 4.6, count: 40 },
        { mag: 4.7, count: 16 },
      ],
      4.5,
      0.1,
    );
    expect(fit).not.toBeNull();
    if (!fit) return;
    const line = fitLine(fit, 6.0);
    expect(line[0].mag).toBe(4.5);
    expect(line[1].mag).toBe(6.0);
    expect(line[0].n).toBeCloseTo(10 ** (fit.a - fit.b * 4.5), 6);
    expect(line[1].n).toBeCloseTo(10 ** (fit.a - fit.b * 6.0), 6);
    // The line descends with magnitude.
    expect(line[1].n).toBeLessThan(line[0].n);
  });
});
