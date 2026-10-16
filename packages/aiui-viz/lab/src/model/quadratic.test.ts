import { describe, expect, it } from "vitest";
import { evaluateStep, fmt, plusRoot, STEPS, substitutedFormula } from "./quadratic";

const CASES = [
  { a: 1, b: -3, c: 1 },
  { a: 2, b: 5, c: -3 },
  { a: 0.5, b: 1, c: -4 },
];

describe("completing the square", () => {
  it("balances at the + root at every step, for several (a, b, c)", () => {
    for (const p of CASES) {
      const x = plusRoot(p);
      expect(p.a * x * x + p.b * x + p.c).toBeCloseTo(0, 9);
      for (const [i, step] of STEPS.entries()) {
        const e = evaluateStep(step, p);
        expect(e.x).toBe(x);
        expect(e.left, `step ${i}: ${step.rule}`).toBeCloseTo(e.right, 9);
      }
    }
  });

  it("keeps term identity across steps", () => {
    const ids = STEPS.map((s) =>
      s.pieces.filter((p) => typeof p !== "string").map((p) => (p as { id: string }).id),
    );
    expect(ids[0]).toEqual(["sq", "lin", "cst", "rhs"]);
    expect(ids[3]).toEqual(["sq", "lin", "sq2", "rhs", "sq2r"]);
    expect(ids[6]).toEqual(["x", "rhs"]);
    for (const [i, s] of STEPS.entries()) for (const f of s.focus) expect(ids[i]).toContain(f);
  });

  it("reports no real root honestly", () => {
    const p = { a: 1, b: 1, c: 1 };
    expect(plusRoot(p)).toBeNaN();
    expect(substitutedFormula(p)).toContain("no real root");
    expect(fmt(Number.NaN)).toBe("\\text{—}");
  });

  it("formats numbers for TeX without noise", () => {
    expect(fmt(0.38196601)).toBe("0.382");
    expect(fmt(-0)).toBe("0");
    expect(fmt(2)).toBe("2");
    expect(substitutedFormula({ a: 1, b: -3, c: 1 })).toContain("= 2.618");
  });
});
