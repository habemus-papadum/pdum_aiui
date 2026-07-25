/**
 * capture.test.ts — the pure half of the shot pipeline: the letterbox fit that
 * maps a rubber-band rect (CSS px) into a stream frame. The numbers in the
 * first test are the LIVE measurement that found the bug (2026-07-17): an
 * unconstrained "tab" track on a 5120×1440 ultrawide carried the 897×751-CSS
 * tab as a 1719×1440 image centered at x≈1700, and the old width-only scale
 * (5120/897 ≈ 5.7) sent every crop into the black bars.
 */
import { describe, expect, it } from "vitest";
import {
  describeMissingStream,
  letterboxFit,
  onHeldStreamChange,
  releaseTabStream,
} from "./capture";

describe("letterboxFit", () => {
  it("maps the measured display-sized frame: height-fit, centered horizontally", () => {
    const fit = letterboxFit({ w: 5120, h: 1440 }, { w: 897, h: 751 });
    expect(fit.scale).toBeCloseTo(1440 / 751, 6); // ≈ 1.9174 — the SMALLER ratio
    expect(fit.offY).toBe(0);
    expect(fit.offX).toBeCloseTo((5120 - 897 * (1440 / 751)) / 2, 6); // ≈ 1700
    // The measured content box: x ∈ [~1700, ~3419].
    expect(fit.offX + 897 * fit.scale).toBeCloseTo(3419.9, 0);
  });

  it("degenerates to scale = dpr, no offsets, for a tab-sized frame", () => {
    // 897×751 CSS at devicePixelRatio 1.875 → a 1682×1408 constrained stream.
    const fit = letterboxFit({ w: 1682, h: 1408 }, { w: 897, h: 751 });
    expect(fit.scale).toBeCloseTo(1.875, 2);
    expect(Math.abs(fit.offX)).toBeLessThan(1);
    expect(Math.abs(fit.offY)).toBeLessThan(1);
  });

  it("pillarboxes a frame TALLER than the tab's aspect (bars top and bottom)", () => {
    const fit = letterboxFit({ w: 1000, h: 2000 }, { w: 1000, h: 1000 });
    expect(fit.scale).toBe(1);
    expect(fit.offX).toBe(0);
    expect(fit.offY).toBe(500);
  });
});

describe("describeMissingStream — the three-way split", () => {
  const REMEDY = "right-click → aiui: grant capture";

  it("names the grant remedy only when there IS no grant", () => {
    expect(describeMissingStream(7, undefined, REMEDY)).toBe(
      `this tab needs a capture grant on the host — ${REMEDY}`,
    );
  });

  it("says wrong-tab when a grant exists elsewhere", () => {
    expect(describeMissingStream(7, 9, REMEDY)).toBe(
      `the host is on a different tab than the granted one — switch back, or grant this one (${REMEDY})`,
    );
  });

  it("points at the turn when the grant is already in place", () => {
    expect(describeMissingStream(7, 7, REMEDY)).toBe(
      "capture is granted — open a turn on the host to start video",
    );
  });

  it("says so when the host has no tab at all", () => {
    expect(describeMissingStream(undefined, undefined, REMEDY)).toBe("the host has no tab in view");
  });
});

describe("onHeldStreamChange", () => {
  it("is edge-only: releasing with nothing held fires no notification", () => {
    let fired = 0;
    const off = onHeldStreamChange(() => {
      fired += 1;
    });
    releaseTabStream(); // nothing held — a no-op release is not an edge
    expect(fired).toBe(0);
    off();
  });
});
