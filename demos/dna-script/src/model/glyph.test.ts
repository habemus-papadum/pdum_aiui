import { describe, expect, it } from "vitest";
import { BASES, type Base, complement } from "./dna";
import {
  bottomEdgeSegments,
  bottomEdgeStart,
  DEFAULT_METRICS,
  duplexLayout,
  type GlyphMetrics,
  glyphFillPath,
  glyphOutlinePath,
  glyphViewBox,
  PROFILE,
  type Pt,
  placedTransform,
  sampleSegments,
} from "./glyph";

const M = DEFAULT_METRICS;

/** The bottom edge of a base, as the dense polyline that gets rendered. */
function edge(base: Base, m: GlyphMetrics = M): Pt[] {
  return sampleSegments(bottomEdgeStart(m), bottomEdgeSegments(base, m), 32);
}

/**
 * Where a point of the *partner* cell lands once that cell is dropped below the
 * strand (offset by one cell height) and turned 180° about its own centre:
 * `(x, y) → (W − x, 2H − y)`. This is the map the duplex renderer applies as an
 * SVG `rotate(...)`, written out arithmetically.
 */
function underRotation(p: Pt, m: GlyphMetrics = M): Pt {
  return { x: m.width - p.x, y: 2 * m.height - p.y };
}

describe("PROFILE — the notation's three rules", () => {
  it("gives complements the same bump family", () => {
    for (const b of BASES) expect(PROFILE[b].family).toBe(PROFILE[complement(b)].family);
  });

  it("gives complements opposite polarity — one tooth, one socket", () => {
    for (const b of BASES) expect(PROFILE[b].polarity).toBe(-PROFILE[complement(b)].polarity);
  });

  it("gives complements the same filled half", () => {
    for (const b of BASES) expect(PROFILE[b].fill).toBe(PROFILE[complement(b)].fill);
  });

  it("distinguishes the two pairs by family and by fill", () => {
    expect(PROFILE.A.family).not.toBe(PROFILE.G.family);
    expect(PROFILE.A.fill).not.toBe(PROFILE.G.fill);
  });

  it("assigns each base a distinct (family, polarity) signature", () => {
    const seen = new Set(BASES.map((b) => `${PROFILE[b].family}/${PROFILE[b].polarity}`));
    expect(seen.size).toBe(BASES.length);
  });
});

describe("tessellation — the tooth exactly fills its socket", () => {
  it.each(
    BASES.map((b) => [b, complement(b)] as const),
  )("%s meshes with %s under a 180° turn", (base, partner) => {
    const mine = edge(base);
    // The partner's own bottom edge, seen after the rotation the renderer
    // applies. Rotation reverses traversal order, hence the reverse().
    const theirs = edge(partner)
      .map((p) => underRotation(p))
      .reverse();

    expect(theirs).toHaveLength(mine.length);
    for (let i = 0; i < mine.length; i++) {
      expect(theirs[i].x).toBeCloseTo(mine[i].x, 10);
      expect(theirs[i].y).toBeCloseTo(mine[i].y, 10);
    }
  });

  it("still meshes at other metrics", () => {
    const m: GlyphMetrics = { width: 20, height: 9, amp: 5, halfWidth: 7 };
    for (const base of BASES) {
      const mine = sampleSegments(bottomEdgeStart(m), bottomEdgeSegments(base, m), 16);
      const theirs = sampleSegments(bottomEdgeStart(m), bottomEdgeSegments(complement(base), m), 16)
        .map((p) => underRotation(p, m))
        .reverse();
      for (let i = 0; i < mine.length; i++) {
        expect(theirs[i].y).toBeCloseTo(mine[i].y, 10);
      }
    }
  });

  it("does NOT mesh with a non-partner — the test has teeth", () => {
    // A against C: same polarity story, wrong family.
    const mine = edge("A");
    const wrong = edge("C")
      .map((p) => underRotation(p))
      .reverse();
    const maxGap = Math.max(...mine.map((p, i) => Math.abs(p.y - wrong[i].y)));
    expect(maxGap).toBeGreaterThan(0.5);
  });
});

describe("bump geometry", () => {
  it("puts a tooth below the baseline and a socket above it", () => {
    for (const base of BASES) {
      const ys = edge(base).map((p) => p.y);
      const extreme = PROFILE[base].polarity > 0 ? Math.max(...ys) : Math.min(...ys);
      const expected = M.height + PROFILE[base].polarity * M.amp;
      // Angular bumps hit the peak exactly; round ones approach it.
      if (PROFILE[base].family === "angular") expect(extreme).toBeCloseTo(expected, 10);
      else expect(Math.abs(extreme - M.height)).toBeGreaterThan(M.amp * 0.5);
    }
  });

  it("starts and ends flat, so adjacent cells butt together seamlessly", () => {
    for (const base of BASES) {
      const pts = edge(base);
      expect(pts[0]).toEqual({ x: 0, y: M.height });
      expect(pts[pts.length - 1].x).toBeCloseTo(M.width, 10);
      expect(pts[pts.length - 1].y).toBeCloseTo(M.height, 10);
    }
  });

  it("is symmetric about the cell centre", () => {
    for (const base of BASES) {
      const pts = edge(base);
      const mirrored = pts.map((p) => ({ x: M.width - p.x, y: p.y })).reverse();
      for (let i = 0; i < pts.length; i++) {
        expect(mirrored[i].y).toBeCloseTo(pts[i].y, 10);
      }
    }
  });

  it("keeps the bump inside the cell width", () => {
    for (const base of BASES) {
      for (const p of edge(base)) {
        expect(p.x).toBeGreaterThanOrEqual(-1e-9);
        expect(p.x).toBeLessThanOrEqual(M.width + 1e-9);
      }
    }
  });
});

describe("paths", () => {
  it("produces a closed outline for every base", () => {
    for (const base of BASES) {
      const d = glyphOutlinePath(base, M);
      expect(d.startsWith("M ")).toBe(true);
      expect(d.trimEnd().endsWith("Z")).toBe(true);
      expect(d).not.toMatch(/NaN|undefined/);
    }
  });

  it("produces a fill path on the declared half", () => {
    for (const base of BASES) {
      const d = glyphFillPath(base, M);
      expect(d).not.toMatch(/NaN|undefined/);
      // A top fill is the plain rectangle above the midline; a bottom fill has
      // to trace the bump, so it carries the edge commands.
      const traced = d.includes("C ") || d.split("L ").length > 4;
      expect(traced).toBe(PROFILE[base].fill === "bottom");
    }
  });

  it("uses one viewBox for every base, so inline glyphs align", () => {
    const boxes = new Set(BASES.map(() => glyphViewBox(M)));
    expect(boxes.size).toBe(1);
    expect(glyphViewBox(M)).toBe(`0 ${-M.amp} ${M.width} ${M.height + 2 * M.amp}`);
  });
});

describe("duplexLayout", () => {
  const seq: Base[] = ["A", "T", "G", "C"];

  it("puts the complement of each base directly beneath it", () => {
    const { top, bottom } = duplexLayout(seq, M);
    for (let i = 0; i < seq.length; i++) {
      expect(top[i].base).toBe(seq[i]);
      expect(bottom[i].base).toBe(complement(seq[i]));
      expect(bottom[i].x).toBe(top[i].x);
      expect(bottom[i].y).toBe(M.height);
      expect(bottom[i].rotated).toBe(true);
    }
  });

  it("shows the partner unturned when asked, and then it does NOT align", () => {
    const { bottom } = duplexLayout(seq, M, { rotateBottom: false });
    // Unrotated, the row is the reverse complement read 5'→3': GCAT.
    expect(bottom.map((g) => g.base).join("")).toBe("GCAT");
    expect(bottom.every((g) => !g.rotated)).toBe(true);
  });

  it("sizes the box to the strand", () => {
    const layout = duplexLayout(seq, M);
    expect(layout.width).toBe(seq.length * M.width);
    expect(layout.height).toBe(2 * M.height);
  });

  it("handles the empty strand", () => {
    const layout = duplexLayout([], M);
    expect(layout.top).toEqual([]);
    expect(layout.width).toBe(0);
  });

  it("places every cell, and turns only the partner row", () => {
    const { top, bottom } = duplexLayout(seq, M);
    expect(placedTransform(top[0], M)).toBe("translate(0 0)");
    expect(placedTransform(top[2], M)).toBe(`translate(${2 * M.width} 0)`);
    expect(placedTransform(bottom[0], M)).toBe(
      `translate(0 ${M.height}) rotate(180 ${M.width / 2} ${M.height / 2})`,
    );
  });
});
