// @vitest-environment jsdom
/**
 * math-selection.test.tsx — the term ladder over real KaTeX output, and the
 * copy handler over prose with equations in it. KaTeX renders in jsdom; the
 * ranges are built on the glyph text nodes of its HTML layer, exactly where a
 * browser puts a user's selection.
 */
import { render } from "@solidjs/web";
import { afterEach, describe, expect, it } from "vitest";
import { clipboardFor, installMathCopy, mathOfRange } from "./math-selection";
import { RichTeX, Term } from "./site/rich-tex";
import { TeX } from "./site/tex";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  document.getSelection()?.removeAllRanges();
});

function mount(el: () => unknown): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  dispose = render(el as never, host);
  return host;
}

/** The non-blank text nodes under an element, in order. */
function textNodes(scope: Element): Text[] {
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  const out: Text[] = [];
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    const t = n as Text;
    if (t.data.trim() !== "") out.push(t);
  }
  return out;
}

/** The glyph text nodes of a KaTeX root's HTML layer (the MathML half is hidden). */
function glyphs(katexRoot: Element): Text[] {
  return textNodes(katexRoot.querySelector(".katex-html") ?? katexRoot);
}

/** The glyph nodes inside one term's span. */
function termGlyphs(host: Element, id: string): Text[] {
  return textNodes(host.querySelector(`[data-aiui-term="${id}"]`) as Element);
}

function range(a: Node, aOff: number, b: Node, bOff: number): Range {
  const r = document.createRange();
  r.setStart(a, aOff);
  r.setEnd(b, bOff);
  return r;
}

function last<T>(xs: T[]): T {
  return xs[xs.length - 1] as T;
}

const Equation = () => (
  <RichTeX display>
    {"x ="}
    <Term id="p">{"a b"}</Term>
    <Term id="q">{"+ c"}</Term>
    {"+"}
    <Term id="outer">
      {"\\beta"}
      <Term id="inner">{"D"}</Term>
    </Term>
  </RichTeX>
);

describe("mathOfRange — the term ladder", () => {
  it("a range inside one term resolves to that term", () => {
    const host = mount(Equation);
    const a = termGlyphs(host, "p")[0] as Text;
    const m = mathOfRange(range(a, 0, a, 1));
    expect(m).toEqual({ tex: "a b", display: false, precision: "term", terms: ["p"] });
  });

  it("a range across two terms and nothing between them resolves to both, in order", () => {
    const host = mount(Equation);
    const first = termGlyphs(host, "p")[0] as Text;
    const lastQ = last(termGlyphs(host, "q"));
    const m = mathOfRange(range(first, 0, lastQ, lastQ.data.length));
    expect(m).toEqual({ tex: "a b + c", display: false, precision: "terms", terms: ["p", "q"] });
  });

  it("a range that also takes a glyph between terms falls back to the whole equation", () => {
    const host = mount(Equation);
    const all = glyphs(host.querySelector(".katex") as Element);
    const equals = all.find((t) => t.data === "=") as Text;
    const lastQ = last(termGlyphs(host, "q"));
    const m = mathOfRange(range(equals, 0, lastQ, lastQ.data.length));
    expect(m?.precision).toBe("equation");
    expect(m?.display).toBe(true);
    expect(m?.tex).toBe("x = a b + c + \\beta D");
    expect(m?.terms).toEqual([]);
  });

  it("nested terms: the smallest term containing the range wins", () => {
    const host = mount(Equation);
    const d = termGlyphs(host, "inner")[0] as Text;
    const m = mathOfRange(range(d, 0, d, 1));
    expect(m).toEqual({ tex: "D", display: false, precision: "term", terms: ["inner"] });
    // …and a range from the outer term's own glyph into the inner one is the outer term.
    const beta = termGlyphs(host, "outer")[0] as Text;
    const m2 = mathOfRange(range(beta, 0, d, 1));
    expect(m2?.precision).toBe("term");
    expect(m2?.terms).toEqual(["outer"]);
    expect(m2?.tex).toBe("\\beta D");
  });

  it("a plain TeX equation resolves whole, with its display flag", () => {
    const host = mount(() => <TeX display tex="E = mc^2" />);
    const g = glyphs(host.querySelector(".katex") as Element);
    const first = g[0] as Text;
    const m = mathOfRange(range(first, 0, first, 1));
    expect(m).toEqual({ tex: "E = mc^2", display: true, precision: "equation", terms: [] });
  });

  it("a range touching no mathematics is nothing", () => {
    const host = mount(() => <p>plain prose</p>);
    const t = host.querySelector("p")?.firstChild as Text;
    expect(mathOfRange(range(t, 0, t, 5))).toBeUndefined();
    expect(clipboardFor(range(t, 0, t, 5))).toBeUndefined();
  });
});

describe("clipboardFor — what copy puts on the clipboard", () => {
  it("prose with inline equations: each becomes $…$ in place, and the HTML flavor carries MathML", () => {
    const host = mount(() => (
      <p>
        mass <TeX tex="m" /> and energy <TeX tex="E" />.
      </p>
    ));
    const p = host.querySelector("p") as HTMLElement;
    const r = document.createRange();
    r.selectNodeContents(p);
    const out = clipboardFor(r);
    expect(out?.text).toBe("mass $m$ and energy $E$.");
    expect(out?.html).toContain("<math");
    expect(out?.html).toContain("<annotation");
    expect(out?.html).not.toContain("katex-html");
  });

  it("a whole display equation selected from inside copies as $$…$$ with MathML", () => {
    const host = mount(() => <TeX display tex="E = mc^2" />);
    const g = glyphs(host.querySelector(".katex") as Element);
    const out = clipboardFor(range(g[0] as Text, 0, last(g), last(g).data.length));
    expect(out?.text).toBe("$$E = mc^2$$");
    expect(out?.html).toMatch(/^<math[^>]*display="block"/);
  });

  it("a selection inside a RichTeX term copies that term alone, as inline TeX", () => {
    const host = mount(Equation);
    const a = termGlyphs(host, "p")[0] as Text;
    const out = clipboardFor(range(a, 0, a, 1));
    expect(out).toEqual({ text: "$a b$" });
  });

  it("prose running into a RichTeX equation keeps the prose and resolves the equation", () => {
    const host = mount(() => (
      <div>
        <p>see</p>
        <Equation />
      </div>
    ));
    const prose = host.querySelector("p")?.firstChild as Text;
    const a = termGlyphs(host, "p")[0] as Text;
    // From the prose into the first glyph of term p: on the way the range
    // takes the free glyphs `x =`, so the honest answer is the whole
    // equation, fenced for display, after the prose.
    const out = clipboardFor(range(prose, 0, a, 1));
    expect(out?.text).toContain("see");
    expect(out?.text).toContain("$$x = a b + c + \\beta D$$");
  });

  it("installMathCopy rewrites a copy event over math and ignores one elsewhere", () => {
    const host = mount(() => (
      <div>
        <p>plain</p>
        <TeX display tex={"\\alpha"} />
      </div>
    ));
    const uninstall = installMathCopy(document);
    const fire = (r: Range) => {
      const sel = document.getSelection() as Selection;
      sel.removeAllRanges();
      sel.addRange(r);
      const data = new Map<string, string>();
      const e = new Event("copy", { bubbles: true, cancelable: true });
      Object.defineProperty(e, "clipboardData", {
        value: { setData: (k: string, v: string) => data.set(k, v) },
      });
      document.dispatchEvent(e);
      return { data, prevented: e.defaultPrevented };
    };
    const g = glyphs(host.querySelector(".katex") as Element);
    const math = fire(range(g[0] as Text, 0, g[0] as Text, 1));
    expect(math.prevented).toBe(true);
    expect(math.data.get("text/plain")).toBe("$$\\alpha$$");

    const t = host.querySelector("p")?.firstChild as Text;
    const prose = fire(range(t, 0, t, 5));
    expect(prose.prevented).toBe(false);
    expect(prose.data.size).toBe(0);
    uninstall();
  });
});
