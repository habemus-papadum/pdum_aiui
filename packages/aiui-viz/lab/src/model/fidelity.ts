/**
 * fidelity.ts — the proof page's data and instrument. The CASES are
 * equations as pieces (strings and named terms, nested), chosen to cover the
 * places a marker could plausibly disturb KaTeX: binary-operator spacing at
 * a term's edges, unary minus, fractions, limits, accents, environments,
 * text mode, sized delimiters, nesting. The unit test pins the DOM skeleton;
 * `measureFidelity` is the browser-side instrument — it pairs every glyph of
 * the plain render with the same glyph of the marked render and reports the
 * largest positional difference in CSS px.
 */

export type Piece = string | { id: string; pieces: readonly Piece[] };
export const term = (id: string, ...pieces: Piece[]): Piece => ({ id, pieces });

export interface FidelityCase {
  id: string;
  title: string;
  pieces: readonly Piece[];
}

export const CASES: readonly FidelityCase[] = [
  {
    id: "binary",
    title: "binary operators at term edges",
    pieces: [term("a", "a"), "+", term("b", "b"), "-", term("c", "c"), "\\cdot", term("d", "d")],
  },
  {
    id: "unary",
    title: "unary minus inside and at the start of a term",
    pieces: [term("m", "-a"), "+", term("b", "b"), term("mc", "-c")],
  },
  {
    id: "fraction",
    title: "terms inside a fraction",
    pieces: [
      "\\frac{",
      term("num", "x+1"),
      "}{",
      term("den", "2y"),
      "}",
      "+",
      term("w", "\\frac{a+b}{c}"),
    ],
  },
  {
    id: "limits",
    title: "terms in limits and a big operator",
    pieces: [
      "\\sum_{",
      term("lo", "i=0"),
      "}^{",
      term("hi", "N"),
      "}",
      term("body", "w_i\\, x_i"),
      "+",
      "\\int_0^1",
      term("f", "f(x)"),
      "\\,dx",
    ],
  },
  {
    id: "accents",
    title: "accents (an SVG inside a zero-width box)",
    pieces: [
      term("v", "\\vec{v}"),
      "\\cdot",
      term("n", "\\hat{n}"),
      "=",
      term("bar", "\\bar{x}"),
      "\\,",
      term("tilde", "\\tilde{y}"),
    ],
  },
  {
    id: "matrix",
    title: "terms as matrix entries",
    pieces: [
      "\\begin{pmatrix}",
      term("a", "a"),
      "&",
      term("b", "b"),
      "\\\\",
      term("c", "c"),
      "&",
      term("d", "d"),
      "\\end{pmatrix}",
    ],
  },
  {
    id: "text",
    title: "text mode and sized delimiters",
    pieces: [
      term("t", "\\text{rate}"),
      "=",
      term("v", "\\Big(\\frac{dN}{dt}\\Big)"),
      term("u", "\\;\\mathrm{s}^{-1}"),
    ],
  },
  {
    id: "nested",
    title: "nested terms",
    pieces: [
      term(
        "outer",
        "\\beta\\,",
        term("inner", "D_{\\mathrm{KL}}"),
        "\\big(\\pi_\\theta\\,\\|\\,\\pi_{\\mathrm{ref}}\\big)",
      ),
    ],
  },
  {
    id: "clip",
    title: "the clipped objective",
    pieces: [
      term(
        "p",
        "\\mathbb{E}_t\\Big[\\min\\big(r_t\\hat A_t,\\ \\mathrm{clip}(r_t, 1-\\epsilon, 1+\\epsilon)\\hat A_t\\big)\\Big]",
      ),
      "-",
      term("k", "\\beta\\, D_{\\mathrm{KL}}"),
    ],
  },
];

export interface FidelityResult {
  id: string;
  /** Glyph and spacing leaves found in the plain render. */
  leaves: number;
  /** Leaves in the marked render — must equal `leaves`. */
  leavesMarked: number;
  /** The largest |Δ| over left/top/width/height across all paired leaves, px. */
  maxDelta: number;
  ok: boolean;
}

/** The leaf boxes of a `.katex-html` tree: glyphs (text leaves) and spacing runs. */
function leaves(root: Element): Element[] {
  return [...root.querySelectorAll("*")].filter(
    (el) =>
      el.classList.contains("mspace") ||
      (el.children.length === 0 && (el.textContent ?? "").trim() !== ""),
  );
}

/**
 * Pair the plain and marked renders of every `.rtx-lab-case` under `root`
 * and measure. Positions are taken relative to each render's own `.katex`
 * box, so the two columns need not align with each other.
 */
export function measureFidelity(root: ParentNode = document): FidelityResult[] {
  const out: FidelityResult[] = [];
  for (const el of root.querySelectorAll<HTMLElement>(".rtx-lab-case[data-case]")) {
    const id = el.dataset.case ?? "?";
    const plain = el.querySelector(".rtx-lab-plain .katex-html");
    const marked = el.querySelector(".rtx-lab-rich .katex-html");
    if (!plain || !marked) continue;
    const a = leaves(plain);
    const b = leaves(marked);
    const ra = plain.getBoundingClientRect();
    const rb = marked.getBoundingClientRect();
    let maxDelta = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const pa = a[i];
      const pb = b[i];
      if (pa === undefined || pb === undefined) break;
      const x = pa.getBoundingClientRect();
      const y = pb.getBoundingClientRect();
      maxDelta = Math.max(
        maxDelta,
        Math.abs(x.left - ra.left - (y.left - rb.left)),
        Math.abs(x.top - ra.top - (y.top - rb.top)),
        Math.abs(x.width - y.width),
        Math.abs(x.height - y.height),
      );
    }
    out.push({
      id,
      leaves: a.length,
      leavesMarked: b.length,
      maxDelta: Number(maxDelta.toFixed(3)),
      ok: a.length === b.length && maxDelta < 0.5,
    });
  }
  return out;
}

/** The plain equation of a case — pieces joined as the assembler joins them
 * (trimmed, single spaces), without building any `<Term>`. */
export function cleanTeX(pieces: readonly Piece[]): string {
  return pieces
    .map((p) => (typeof p === "string" ? p.trim() : cleanTeX(p.pieces)))
    .filter((s) => s !== "")
    .join(" ");
}
