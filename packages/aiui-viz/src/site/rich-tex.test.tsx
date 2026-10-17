// @vitest-environment jsdom
/**
 * rich-tex.test.tsx — the pieces→equation assembler, the layout-neutrality
 * of the markers (the claim the whole component rests on), and the mounted
 * component's two reactive levels and attribution stamps.
 */
import { render } from "@solidjs/web";
import katex from "katex";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { control } from "../control";
import { resetControlSurface, tick } from "../testing";
import { assembleTeX, RichTeX, renderMarked, TERM_ATTR, Term } from "./rich-tex";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  resetControlSurface();
});

function mount(el: () => unknown): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  dispose = render(el as never, host);
  return host;
}

describe("assembleTeX", () => {
  it("joins strings and terms with spaces and marks each term", () => {
    const a = assembleTeX(["a +", Term({ id: "b", children: "b" }), "= c"]);
    expect(a.error).toBeUndefined();
    expect(a.clean).toBe("a + b = c");
    expect(a.marked).toBe("a + \\htmlData{aiui-term=b}{b} = c");
    expect(a.terms.map((t) => [t.id, t.tex])).toEqual([["b", "b"]]);
  });

  it("nests terms, parent before child, with clean inner tex per term", () => {
    const inner = Term({ id: "inner", children: "D_{KL}" });
    const outer = Term({ id: "outer", children: ["\\beta", inner] });
    const a = assembleTeX(outer);
    expect(a.clean).toBe("\\beta D_{KL}");
    expect(a.marked).toBe(
      "\\htmlData{aiui-term=outer}{\\beta \\htmlData{aiui-term=inner}{D_{KL}}}",
    );
    expect(a.terms.map((t) => t.id)).toEqual(["outer", "inner"]);
    expect(a.terms[0]?.tex).toBe("\\beta D_{KL}");
    expect(a.terms[1]?.tex).toBe("D_{KL}");
  });

  it("resolves functions, numbers, nested arrays, and skips blanks and booleans", () => {
    const a = assembleTeX([() => "x^", 2, ["", null, false, [" + ", 1]]]);
    expect(a.clean).toBe("x^ 2 + 1");
  });

  it("reports a bad id, a duplicate id, and a non-TeX child instead of throwing", () => {
    expect(assembleTeX(Term({ id: "a,b", children: "x" })).error).toMatch(/term id/);
    expect(
      assembleTeX([Term({ id: "a", children: "x" }), Term({ id: "a", children: "y" })]).error,
    ).toMatch(/duplicate/);
    expect(assembleTeX(document.createElement("span")).error).toMatch(/DOM node/);
  });
});

/**
 * The atom-and-spacing skeleton of a KaTeX render: the MathML half dropped,
 * every marker span unwrapped, every `.base` unwrapped and its strut removed
 * (KaTeX splits an unmarked expression into several `base` spans at break
 * opportunities; a marked group is one base — the line box is identical, the
 * DOM is not). What remains is the sequence of glyph atoms and `mspace`
 * runs with their margins, which must be byte-identical.
 */
function skeleton(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const el of doc.querySelectorAll(".katex-mathml, .strut")) el.remove();
  for (const el of doc.querySelectorAll(`[${TERM_ATTR}], .base`)) el.replaceWith(...el.childNodes);
  return doc.body.innerHTML;
}

const FIDELITY: Array<[string, unknown]> = [
  ["binary", [Term({ id: "a", children: "a" }), "+", Term({ id: "b", children: "b" }), "- c"]],
  ["leading minus", [Term({ id: "m", children: "-a" }), "+", Term({ id: "b", children: "b" })]],
  ["inner minus", [Term({ id: "a", children: "a" }), Term({ id: "mb", children: "-b" })]],
  ["whole", [Term({ id: "w", children: "a+b" })]],
  [
    "fraction",
    ["\\frac{", Term({ id: "n", children: "x+1" }), "}{", Term({ id: "d", children: "y" }), "}"],
  ],
  [
    "limits",
    [
      "\\sum_{",
      Term({ id: "lo", children: "i=0" }),
      "}^{",
      Term({ id: "hi", children: "N" }),
      "}",
      Term({ id: "body", children: "w_i x_i" }),
    ],
  ],
  [
    "nested",
    [
      Term({
        id: "outer",
        children: ["\\beta\\,", Term({ id: "inner", children: "D_{KL}" }), "(\\pi\\|\\pi_{ref})"],
      }),
    ],
  ],
  [
    "accent",
    [Term({ id: "v", children: "\\vec{v}" }), "\\cdot", Term({ id: "n", children: "\\hat n" })],
  ],
  [
    "clip",
    [
      Term({
        id: "p",
        children:
          "\\mathbb{E}\\big[\\min(r\\hat A, \\mathrm{clip}(r,1-\\epsilon,1+\\epsilon)\\hat A)\\big]",
      }),
      "-",
      Term({ id: "k", children: "\\beta\\, D_{KL}(\\pi\\|\\pi_{ref})" }),
    ],
  ],
];

describe("markers change no layout", () => {
  for (const [name, children] of FIDELITY) {
    for (const display of [false, true]) {
      it(`${name} (${display ? "display" : "inline"})`, () => {
        const a = assembleTeX(children);
        expect(a.error).toBeUndefined();
        const plain = katex.renderToString(a.clean, { throwOnError: false, displayMode: display });
        const marked = renderMarked(a.marked, display);
        expect(marked).not.toContain("katex-error");
        expect(marked.match(new RegExp(TERM_ATTR, "g"))?.length).toBe(a.terms.length);
        expect(skeleton(marked)).toBe(skeleton(plain));
      });
    }
  }

  it("refuses a term that is not a balanced group, visibly", () => {
    const a = assembleTeX([
      Term({ id: "l", children: "\\left(" }),
      "a",
      Term({ id: "r", children: "\\right)" }),
    ]);
    expect(renderMarked(a.marked, true)).toContain("katex-error");
  });

  it("admits only our marker through trust: any other HTML command renders as red text", () => {
    // KaTeX renders an untrusted command as its name in the error color — no
    // span, no attribute — rather than as a parse error.
    for (const tex of ["\\htmlClass{evil}{x}", "\\htmlId{evil}{x}", "\\htmlData{onclick=1}{x}"]) {
      const out = renderMarked(tex, false);
      expect(out).not.toContain("enclosing");
      expect(out).not.toContain("data-onclick");
      expect(out).toContain("#cc0000");
    }
    const ok = renderMarked("\\htmlData{aiui-term=ok}{x}", false);
    expect(ok).toContain(`${TERM_ATTR}="ok"`);
    expect(ok).not.toContain("#cc0000");
  });
});

describe("<RichTeX>", () => {
  it("stamps the clean equation on the root and each term's tex on its span", () => {
    const host = mount(() => (
      <RichTeX display>
        {"a +"}
        <Term id="b">{"b"}</Term>
      </RichTeX>
    ));
    const root = host.querySelector(".math-display.aiui-rtx");
    expect(root?.getAttribute("data-tex")).toBe("a + b");
    const span = host.querySelector<HTMLElement>(`[${TERM_ATTR}="b"]`);
    expect(span?.getAttribute("data-tex")).toBe("b");
    expect(span?.classList.contains("aiui-rtx-term")).toBe(true);
    expect(span?.classList.contains("enclosing")).toBe(true);
    // The MathML annotation carries the MARKED string; the stamp is the truth.
    expect(host.querySelector("annotation")?.textContent).toContain("\\htmlData");
  });

  it("decorates in place: a color change keeps the KaTeX DOM, a tex change replaces it", async () => {
    const [color, setColor] = createSignal("rgb(1, 2, 3)");
    const [tex, setTex] = createSignal("b");
    const host = mount(() => (
      <RichTeX display>
        {"a +"}
        <Term id="b" color={color()} class="hot" active={color() !== "rgb(1, 2, 3)"}>
          {tex()}
        </Term>
      </RichTeX>
    ));
    const before = host.querySelector<HTMLElement>(`[${TERM_ATTR}="b"]`);
    expect(before?.style.color).toBe("rgb(1, 2, 3)");
    expect(before?.hasAttribute("data-active")).toBe(false);
    expect(before?.classList.contains("hot")).toBe(true);

    setColor("rgb(9, 9, 9)");
    await tick();
    const after = host.querySelector<HTMLElement>(`[${TERM_ATTR}="b"]`);
    expect(after).toBe(before); // same element — no re-render for a decoration
    expect(after?.style.color).toBe("rgb(9, 9, 9)");
    expect(after?.getAttribute("data-active")).toBe("true");

    setTex("c^2");
    await tick();
    const replaced = host.querySelector<HTMLElement>(`[${TERM_ATTR}="b"]`);
    expect(replaced).not.toBe(before);
    expect(replaced?.getAttribute("data-tex")).toBe("c^2");
    expect(replaced?.style.color).toBe("rgb(9, 9, 9)"); // decoration re-applied
    expect(host.querySelector(".aiui-rtx")?.getAttribute("data-tex")).toBe("a + c^2");
  });

  it("renders a note per annotated term in the layer for its side", () => {
    const host = mount(() => (
      <RichTeX display>
        <Term id="x" note={<i>under</i>}>
          {"x"}
        </Term>
        {"+"}
        <Term id="y" place="above" note={<b>over</b>}>
          {"y"}
        </Term>
        {"+"}
        <Term id="z">{"z"}</Term>
      </RichTeX>
    ));
    expect(host.querySelector(".aiui-notes-below .aiui-note[data-for=x] i")?.textContent).toBe(
      "under",
    );
    expect(host.querySelector(".aiui-notes-above .aiui-note[data-for=y] b")?.textContent).toBe(
      "over",
    );
    expect(host.querySelectorAll(".aiui-note").length).toBe(2);
    // The strips are the shared layer's margin layout, one per side.
    expect(host.querySelectorAll(".aiui-notes.aiui-notes-margin").length).toBe(2);
  });

  it("renders inline without a notes layer", () => {
    const host = mount(() => (
      <RichTeX>
        <Term id="x" note={<i>never</i>}>
          {"x"}
        </Term>
      </RichTeX>
    ));
    expect(host.querySelector("span.math-inline.aiui-rtx")).not.toBeNull();
    expect(host.querySelector(".aiui-note")).toBeNull();
  });

  it("shows a structural error in place instead of throwing", () => {
    const host = mount(() => (
      <RichTeX display>
        <Term id="a">{"x"}</Term>
        <Term id="a">{"y"}</Term>
      </RichTeX>
    ));
    expect(host.querySelector(".aiui-rtx-error")?.textContent).toMatch(/duplicate/);
  });
});

describe("knobs — a term bound to a control", () => {
  const PE = typeof PointerEvent === "function" ? PointerEvent : MouseEvent;

  it("stamps the knob: data-control, role slider, aria values, the id from the control", () => {
    const eps = control({ name: "rtx-eps-a", value: 0.2, min: 0, max: 1, step: 0.05 });
    const host = mount(() => (
      <RichTeX display>
        {"1 -"}
        <Term control={eps}>{"\\epsilon"}</Term>
      </RichTeX>
    ));
    const span = host.querySelector<HTMLElement>(`[${TERM_ATTR}="rtx-eps-a"]`);
    expect(span?.classList.contains("aiui-knob")).toBe(true);
    expect(span?.getAttribute("data-control")).toBe("rtx-eps-a");
    expect(span?.getAttribute("role")).toBe("slider");
    expect(span?.getAttribute("tabindex")).toBe("0");
    expect(span?.getAttribute("aria-valuemin")).toBe("0");
    expect(span?.getAttribute("aria-valuemax")).toBe("1");
    expect(span?.getAttribute("aria-valuenow")).toBe("0.2");
    expect(span?.getAttribute("aria-valuetext")).toBe("0.20"); // the step's precision
    expect(span?.getAttribute("data-tex")).toBe("\\epsilon");
    expect(host.querySelector(".aiui-rtx")?.getAttribute("data-tex")).toBe("1 - \\epsilon");
  });

  it("a drag moves the control through its validation, and the readout shows while hot", async () => {
    const eps = control({ name: "rtx-eps-b", value: 0.2, min: 0, max: 1, step: 0.05 });
    const host = mount(() => (
      <RichTeX display>
        <Term control={eps} span={240}>
          {"\\epsilon"}
        </Term>
      </RichTeX>
    ));
    const span = host.querySelector<HTMLElement>(`[${TERM_ATTR}="rtx-eps-b"]`) as HTMLElement;
    const math = host.querySelector(".aiui-rtx-math") as HTMLElement;
    expect(host.querySelector(".aiui-knob-readout")).toBeNull();
    span.dispatchEvent(new PE("pointerover", { bubbles: true }));
    await tick();
    expect(host.querySelector(".aiui-knob-readout")?.textContent).toContain("0.20");
    expect(host.querySelector(".aiui-knob-readout")?.getAttribute("data-control")).toBe(
      "rtx-eps-b",
    );

    span.dispatchEvent(new PE("pointerdown", { bubbles: true, button: 0, clientX: 100 }));
    expect(span.getAttribute("data-scrubbing")).toBe("true");
    math.dispatchEvent(new PE("pointermove", { bubbles: true, clientX: 160 })); // 60 of 240 px: +0.25
    await tick();
    expect(eps.get()).toBeCloseTo(0.45, 9);
    expect(host.querySelector(".aiui-knob-readout")?.textContent).toContain("0.45");
    math.dispatchEvent(new PE("pointermove", { bubbles: true, clientX: 1000 })); // past the range: clamped
    await tick();
    expect(eps.get()).toBe(1);
    math.dispatchEvent(new PE("pointerup", { bubbles: true }));
    expect(span.hasAttribute("data-scrubbing")).toBe(false);
    span.dispatchEvent(new PE("pointerleave", { bubbles: true }));
    math.dispatchEvent(new PE("pointerleave", { bubbles: false }));
    await tick();
    expect(host.querySelector(".aiui-knob-readout")).toBeNull();
  });

  it("arrow keys step a focused knob; Shift multiplies; Home and End go to the bounds", async () => {
    const eps = control({ name: "rtx-eps-c", value: 0.2, min: 0, max: 1, step: 0.05 });
    const host = mount(() => (
      <RichTeX display>
        <Term control={eps}>{"\\epsilon"}</Term>
      </RichTeX>
    ));
    const span = host.querySelector<HTMLElement>(`[${TERM_ATTR}="rtx-eps-c"]`) as HTMLElement;
    const key = (k: string, shiftKey = false) =>
      span.dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey, bubbles: true }));
    key("ArrowRight");
    await tick();
    expect(eps.get()).toBeCloseTo(0.25, 9);
    key("ArrowLeft", true); // ten steps down, clamped at the floor
    await tick();
    expect(eps.get()).toBe(0);
    key("End");
    await tick();
    expect(eps.get()).toBe(1);
    key("Home");
    await tick();
    expect(eps.get()).toBe(0);
  });

  it("a term needs an id or a control; two knobs on one control need explicit ids", () => {
    const eps = control({ name: "rtx-eps-d", value: 0.2, min: 0, max: 1, step: 0.05 });
    expect(assembleTeX(Term({ children: "x" })).error).toMatch(/needs an id/);
    const twice = assembleTeX([
      Term({ control: eps, children: "\\epsilon" }),
      Term({ control: eps, children: "\\epsilon" }),
    ]);
    expect(twice.error).toMatch(/duplicate/);
    const named = assembleTeX([
      "1 -",
      Term({ id: "eps1", control: eps, children: "\\epsilon" }),
      ", 1 +",
      Term({ id: "eps2", control: eps, children: "\\epsilon" }),
    ]);
    expect(named.error).toBeUndefined();
    expect(named.terms.map((t) => t.id)).toEqual(["eps1", "eps2"]);
  });
});

describe("clickable terms — a keyboard path", () => {
  it("a term with onClick is focusable and answers Enter and Space", async () => {
    let clicks = 0;
    const host = mount(() => (
      <RichTeX display>
        <Term
          id="k3"
          onClick={() => {
            clicks++;
          }}
        >
          {"\\sin 3x"}
        </Term>
        {"+"}
        <Term id="plain">{"y"}</Term>
      </RichTeX>
    ));
    const span = host.querySelector<HTMLElement>(`[${TERM_ATTR}="k3"]`) as HTMLElement;
    expect(span.getAttribute("tabindex")).toBe("0");
    expect(span.getAttribute("role")).toBe("button");
    expect(host.querySelector(`[${TERM_ATTR}="plain"]`)?.hasAttribute("tabindex")).toBe(false);
    span.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    span.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    span.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await tick();
    expect(clicks).toBe(2);
  });
});
