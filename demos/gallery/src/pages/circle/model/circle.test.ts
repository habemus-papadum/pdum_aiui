// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  centroid,
  fitCircle,
  fitEllipseMoments,
  sampleEllipse,
  summarize,
  sweepDegrees,
} from "./circle";

describe("centroid", () => {
  it("averages the points", () => {
    const c = centroid([
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 2 },
      { x: 0, y: 2 },
    ]);
    expect(c.x).toBeCloseTo(1);
    expect(c.y).toBeCloseTo(1);
  });
});

describe("fitCircle", () => {
  it("recovers an exact circle's centre and radius", () => {
    const pts = sampleEllipse({ cx: 300, cy: 200, a: 100, b: 100, n: 128 });
    const fit = fitCircle(pts);
    expect(fit).not.toBeNull();
    if (fit === null) return;
    expect(fit.cx).toBeCloseTo(300, 3);
    expect(fit.cy).toBeCloseTo(200, 3);
    expect(fit.r).toBeCloseTo(100, 3);
    expect(fit.radialRms).toBeCloseTo(0, 3);
  });

  it("is translation- and radius-agnostic", () => {
    const fit = fitCircle(sampleEllipse({ cx: -50, cy: 1000, a: 7.5, b: 7.5, n: 64 }));
    expect(fit?.r).toBeCloseTo(7.5, 4);
    expect(fit?.cx).toBeCloseTo(-50, 4);
    expect(fit?.cy).toBeCloseTo(1000, 4);
  });

  it("returns null for fewer than three points", () => {
    expect(fitCircle([{ x: 0, y: 0 }])).toBeNull();
    expect(
      fitCircle([
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ]),
    ).toBeNull();
  });

  it("returns null for collinear points (degenerate fit)", () => {
    expect(
      fitCircle([
        { x: 0, y: 0 },
        { x: 1, y: 1 },
        { x: 2, y: 2 },
        { x: 3, y: 3 },
      ]),
    ).toBeNull();
  });

  it("reports non-zero wobble when points miss the circle", () => {
    const pts = sampleEllipse({ cx: 0, cy: 0, a: 50, b: 50, n: 64 });
    pts[10] = { x: pts[10].x * 1.3, y: pts[10].y * 1.3 }; // one bump outward
    const fit = fitCircle(pts);
    expect(fit).not.toBeNull();
    expect(fit?.radialRms ?? 0).toBeGreaterThan(0.5);
  });
});

describe("fitEllipseMoments", () => {
  it("reads a circle as zero eccentricity", () => {
    const e = fitEllipseMoments(sampleEllipse({ cx: 0, cy: 0, a: 40, b: 40, n: 96 }), 40);
    expect(e).not.toBeNull();
    expect(e?.eccentricity ?? 1).toBeLessThan(0.05);
    expect(e?.axisRatio ?? 0).toBeCloseTo(1, 1);
  });

  it("recovers the axis ratio of an ellipse", () => {
    const pts = sampleEllipse({ cx: 10, cy: 20, a: 200, b: 100, n: 200 });
    const fit = fitCircle(pts);
    const e = fitEllipseMoments(pts, fit?.r ?? 0);
    expect(e).not.toBeNull();
    if (e === null) return;
    expect(e.axisRatio).toBeCloseTo(0.5, 1);
    expect(e.eccentricity).toBeCloseTo(Math.sqrt(1 - 0.25), 1);
    expect(e.major).toBeGreaterThan(e.minor);
    // geometric mean of the reported axes tracks the fit radius
    expect(Math.sqrt(e.major * e.minor)).toBeCloseTo(fit?.r ?? 0, 3);
  });

  it("recovers the tilt of a rotated ellipse", () => {
    const angle = (30 * Math.PI) / 180;
    const pts = sampleEllipse({ cx: 0, cy: 0, a: 150, b: 60, n: 200, angle });
    const e = fitEllipseMoments(pts, 100);
    expect(e?.tiltDeg ?? 0).toBeCloseTo(30, 0);
  });
});

describe("sweepDegrees", () => {
  it("is ~360 for one loop", () => {
    const pts = sampleEllipse({ cx: 0, cy: 0, a: 30, b: 30, n: 400 });
    expect(sweepDegrees(pts, { x: 0, y: 0 })).toBeGreaterThan(355);
    expect(sweepDegrees(pts, { x: 0, y: 0 })).toBeLessThanOrEqual(360);
  });

  it("is ~180 for a half loop and ~720 for two", () => {
    const half = sampleEllipse({ cx: 0, cy: 0, a: 30, b: 30, n: 400, turns: 0.5 });
    const two = sampleEllipse({ cx: 0, cy: 0, a: 30, b: 30, n: 800, turns: 2 });
    expect(sweepDegrees(half, { x: 0, y: 0 })).toBeCloseTo(180, -1);
    expect(sweepDegrees(two, { x: 0, y: 0 })).toBeCloseTo(720, -1);
  });
});

describe("summarize", () => {
  it("scores a clean circle near 100", () => {
    const s = summarize(sampleEllipse({ cx: 200, cy: 200, a: 120, b: 120, n: 256 }));
    expect(s).not.toBeNull();
    if (s === null) return;
    expect(s.score).toBeGreaterThanOrEqual(97);
    expect(s.roundness).toBeGreaterThan(0.97);
    expect(s.eccentricity).toBeLessThan(0.05);
    expect(s.closureGap).toBeLessThan(5); // one sample gap on an open sweep
    expect(s.sweepDeg).toBeGreaterThan(355);
    expect(s.radius).toBeCloseTo(120, 2);
  });

  it("penalises an ellipse for eccentricity", () => {
    const circle = summarize(sampleEllipse({ cx: 0, cy: 0, a: 100, b: 100, n: 256 }));
    const ellipse = summarize(sampleEllipse({ cx: 0, cy: 0, a: 160, b: 80, n: 256 }));
    expect(ellipse).not.toBeNull();
    if (circle === null || ellipse === null) return;
    expect(ellipse.eccentricity).toBeGreaterThan(0.8);
    expect(ellipse.score).toBeLessThan(circle.score);
    // calibration: a 2:1 egg must read as clearly imperfect, not "basically a
    // circle" — the failure the isoperimetric score had (it scored such an
    // ellipse ~0.92). Radial-CV roundness puts it well below 70.
    expect(ellipse.score).toBeLessThan(65);
    expect(circle.score).toBeGreaterThanOrEqual(97);
  });

  it("rewards a slightly-wobbly hand circle in the 90s", () => {
    // ~2% radial wobble, a full clean loop — a good freehand circle
    const pts = sampleEllipse({ cx: 0, cy: 0, a: 150, b: 150, n: 200 }).map((p, i) => {
      const w = 1 + 0.02 * Math.sin((i / 200) * 2 * Math.PI * 5);
      return { x: p.x * w, y: p.y * w };
    });
    const s = summarize(pts);
    expect(s?.score ?? 0).toBeGreaterThanOrEqual(88);
    expect(s?.score ?? 0).toBeLessThanOrEqual(99);
  });

  it("penalises an incomplete loop through completeness", () => {
    const half = summarize(sampleEllipse({ cx: 0, cy: 0, a: 100, b: 100, n: 256, turns: 0.5 }));
    expect(half).not.toBeNull();
    if (half === null) return;
    expect(half.sweepDeg).toBeCloseTo(180, -1);
    expect(half.score).toBeLessThan(60);
  });

  it("reports an open stroke's closure gap", () => {
    // three-quarter arc: ends nowhere near where it began
    const arc = sampleEllipse({ cx: 0, cy: 0, a: 50, b: 50, n: 128, turns: 0.75 });
    const s = summarize(arc);
    expect(s).not.toBeNull();
    expect(s?.closureGap ?? 0).toBeGreaterThan(40);
    expect(s?.closureRatio ?? 0).toBeGreaterThan(0.8);
  });

  it("returns null for too-short or degenerate strokes", () => {
    expect(
      summarize([
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ]),
    ).toBeNull();
    expect(
      summarize([
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 2, y: 0 },
      ]),
    ).toBeNull();
  });
});
