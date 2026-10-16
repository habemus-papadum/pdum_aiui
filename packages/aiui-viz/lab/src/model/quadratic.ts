/**
 * quadratic.ts — completing the square, as DATA: seven steps from
 * ax² + bx + c = 0 to the quadratic formula, each a list of pieces (plain TeX
 * and named terms). A term keeps its id across steps — the linear term is
 * `lin` whether it reads bx or (b/a)x — so its color can follow it through
 * the derivation. Every term also knows how to EVALUATE itself at (a, b, c, x),
 * which is what makes the derivation honest: at x = a root, the left side
 * equals the right side at every step, and the test proves it.
 */

export interface QuadParams {
  a: number;
  b: number;
  c: number;
}

export interface QTerm {
  id: string;
  tex: string;
  side: "L" | "R";
  value: (p: QuadParams, x: number) => number;
}
export type QPiece = string | QTerm;

export interface QStep {
  /** The rule applied to reach this step (empty for the start). */
  rule: string;
  /** The terms this step touched — highlighted. */
  focus: readonly string[];
  pieces: readonly QPiece[];
}

const t = (id: string, side: "L" | "R", tex: string, value: QTerm["value"]): QTerm => ({
  id,
  tex,
  side,
  value,
});

const half = (p: QuadParams) => p.b / (2 * p.a);

export const STEPS: readonly QStep[] = [
  {
    rule: "",
    focus: [],
    pieces: [
      t("sq", "L", "a x^2", (p, x) => p.a * x * x),
      "+",
      t("lin", "L", "b x", (p, x) => p.b * x),
      "+",
      t("cst", "L", "c", (p) => p.c),
      "=",
      t("rhs", "R", "0", () => 0),
    ],
  },
  {
    rule: "divide through by a",
    focus: ["sq", "lin", "cst"],
    pieces: [
      t("sq", "L", "x^2", (_p, x) => x * x),
      "+",
      t("lin", "L", "\\frac{b}{a}\\, x", (p, x) => (p.b / p.a) * x),
      "+",
      t("cst", "L", "\\frac{c}{a}", (p) => p.c / p.a),
      "=",
      t("rhs", "R", "0", () => 0),
    ],
  },
  {
    rule: "move the constant across",
    focus: ["rhs"],
    pieces: [
      t("sq", "L", "x^2", (_p, x) => x * x),
      "+",
      t("lin", "L", "\\frac{b}{a}\\, x", (p, x) => (p.b / p.a) * x),
      "=",
      t("rhs", "R", "-\\frac{c}{a}", (p) => -p.c / p.a),
    ],
  },
  {
    rule: "complete the square: add (b/2a)² to both sides",
    focus: ["sq2", "sq2r"],
    pieces: [
      t("sq", "L", "x^2", (_p, x) => x * x),
      "+",
      t("lin", "L", "\\frac{b}{a}\\, x", (p, x) => (p.b / p.a) * x),
      "+",
      t("sq2", "L", "\\left(\\frac{b}{2a}\\right)^{2}", (p) => half(p) ** 2),
      "=",
      t("rhs", "R", "-\\frac{c}{a}", (p) => -p.c / p.a),
      "+",
      t("sq2r", "R", "\\left(\\frac{b}{2a}\\right)^{2}", (p) => half(p) ** 2),
    ],
  },
  {
    rule: "factor the left side; combine the right over 4a²",
    focus: ["sq2", "rhs"],
    pieces: [
      t("sq2", "L", "\\left(x + \\frac{b}{2a}\\right)^{2}", (p, x) => (x + half(p)) ** 2),
      "=",
      t("rhs", "R", "\\frac{b^2 - 4ac}{4a^2}", (p) => discriminant(p) / (4 * p.a * p.a)),
    ],
  },
  {
    rule: "take the square root of both sides",
    focus: ["sq2", "rhs"],
    pieces: [
      t("sq2", "L", "x + \\frac{b}{2a}", (p, x) => x + half(p)),
      "=",
      t(
        "rhs",
        "R",
        "\\pm\\, \\frac{\\sqrt{b^2 - 4ac}}{2a}",
        (p) => Math.sqrt(discriminant(p)) / (2 * p.a),
      ),
    ],
  },
  {
    rule: "isolate x",
    focus: ["x", "rhs"],
    pieces: [
      t("x", "L", "x", (_p, x) => x),
      "=",
      t(
        "rhs",
        "R",
        "\\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}",
        (p) => (-p.b + Math.sqrt(discriminant(p))) / (2 * p.a),
      ),
    ],
  },
];

export function discriminant(p: QuadParams): number {
  return p.b * p.b - 4 * p.a * p.c;
}

/** The "+" root, or NaN when the discriminant is negative. */
export function plusRoot(p: QuadParams): number {
  const d = discriminant(p);
  return d < 0 ? Number.NaN : (-p.b + Math.sqrt(d)) / (2 * p.a);
}

export interface StepEvaluation {
  x: number;
  discriminant: number;
  /** Every term's value at (p, x), by id. */
  values: Record<string, number>;
  /** The two sides summed — equal at a root, at every step. */
  left: number;
  right: number;
}

/** Evaluate a step's terms at the + root of (a, b, c). */
export function evaluateStep(step: QStep, p: QuadParams): StepEvaluation {
  const x = plusRoot(p);
  const values: Record<string, number> = {};
  let left = 0;
  let right = 0;
  for (const piece of step.pieces) {
    if (typeof piece === "string") continue;
    const v = piece.value(p, x);
    values[piece.id] = v;
    if (piece.side === "L") left += v;
    else right += v;
  }
  return { x, discriminant: discriminant(p), values, left, right };
}

/** The formula with the numbers substituted — the reactive equation under the
 * stepper. `\\pm` is resolved to the + root the notes evaluate. */
export function substitutedFormula(p: QuadParams): string {
  const num = (v: number) => (v < 0 ? `(${fmt(v)})` : fmt(v));
  const d = discriminant(p);
  const root = plusRoot(p);
  const result = Number.isNaN(root) ? "\\text{no real root}" : fmt(root);
  return `x_{+} = \\frac{-${num(p.b)} + \\sqrt{${num(p.b)}^2 - 4\\cdot${num(p.a)}\\cdot${num(p.c)}}}{2\\cdot${num(p.a)}} = \\frac{${fmt(-p.b)} + \\sqrt{${fmt(d)}}}{${fmt(2 * p.a)}} = ${result}`;
}

/** Up to three decimals, no trailing zeros, "−0" normalized. */
export function fmt(v: number): string {
  if (Number.isNaN(v)) return "\\text{—}";
  const s = Number(v.toFixed(3));
  return String(s === 0 ? 0 : s);
}
