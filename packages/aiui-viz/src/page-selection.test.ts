// @vitest-environment jsdom
/**
 * page-selection: the document's selection as text + TeX + attribution
 * (element chain, cell chain, control), its memory across a focus steal,
 * and the knobs (maxChars, depth, source, rects, format).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPageSelection,
  describeRange,
  pageSelection,
  SELECTION_TTL_MS,
  splitLoc,
} from "./page-selection";

const PAGE = `
  <main data-source-loc="src/ui/App.tsx:5:3">
    <section data-cell="analysis" data-cell-loc="src/model/graph.ts:31">
      <article data-cell="rose" data-source-loc="src/ui/Picture.tsx:12:4">
        <p data-source-loc="src/ui/Picture.tsx:14:6"><span id="leaf">petals and thorns</span></p>
        <table><tr><th>k</th><th>v</th></tr><tr><td id="k">kappa</td><td>2</td></tr></table>
      </article>
    </section>
    <label data-control="kappa"><span id="ctl">κ</span><input type="range"></label>
    <span class="math-inline" data-tex="x^2" id="math">x<span aria-hidden="true">2</span></span>
  </main>
  <aside data-aiui-chrome=""><p id="chrome">calls (3)</p></aside>`;

/** Select from inside `el` (where a drag starts) to the end of `to`. */
function select(el: Element, to: Element = el): Range {
  const range = document.createRange();
  range.setStart(el, 0);
  range.setEndAfter(to);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  return range;
}

const byId = (id: string): Element => {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`no #${id}`);
  return el;
};

beforeEach(() => {
  document.body.innerHTML = PAGE;
  clearPageSelection();
  delete (window as unknown as { __aiuiCells?: unknown }).__aiuiCells;
});

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  vi.useRealTimers();
});

describe("splitLoc", () => {
  it("splits file:line:col, file:line, and keeps a bare file", () => {
    expect(splitLoc("src/ui/App.tsx:42:7")).toEqual({
      loc: "src/ui/App.tsx:42:7",
      file: "src/ui/App.tsx",
      line: 42,
      col: 7,
    });
    expect(splitLoc("../seismos/src/model/graph.ts:31")).toEqual({
      loc: "../seismos/src/model/graph.ts:31",
      file: "../seismos/src/model/graph.ts",
      line: 31,
    });
    expect(splitLoc("src/a.ts")).toEqual({ loc: "src/a.ts", file: "src/a.ts" });
  });
});

describe("pageSelection", () => {
  it("is null on a page with nothing selected", () => {
    expect(pageSelection()).toBeNull();
  });

  it("reports the text with the element chain, the cell chain and the control", () => {
    select(byId("leaf"));
    const s = pageSelection();
    expect(s).toMatchObject({ text: "petals and thorns", chars: 17, truncated: false, live: true });
    expect(s?.elements).toEqual([
      { tag: "p", loc: "src/ui/Picture.tsx:14:6", file: "src/ui/Picture.tsx", line: 14, col: 6 },
      {
        tag: "article",
        loc: "src/ui/Picture.tsx:12:4",
        file: "src/ui/Picture.tsx",
        line: 12,
        col: 4,
      },
      { tag: "main", loc: "src/ui/App.tsx:5:3", file: "src/ui/App.tsx", line: 5, col: 3 },
    ]);
    // Nearest cell first; `rose` has no data-cell-loc, so its own JSX stamp stands in.
    expect(s?.cells).toEqual([
      {
        name: "rose",
        loc: "src/ui/Picture.tsx:12:4",
        file: "src/ui/Picture.tsx",
        line: 12,
        col: 4,
      },
      { name: "analysis", loc: "src/model/graph.ts:31", file: "src/model/graph.ts", line: 31 },
    ]);
    expect(s?.control).toBeUndefined();
    expect(s?.url).toBe(location.href);

    select(byId("ctl"));
    expect(pageSelection()?.control).toBe("kappa");
  });

  it("reads the cell registry's bridge for a definition site and the live state", () => {
    (window as unknown as { __aiuiCells?: unknown }).__aiuiCells = {
      loc: (name: string) => (name === "rose" ? "src/model/rose.ts:9" : undefined),
      state: (name: string) => (name === "rose" ? "fresh" : "stale"),
    };
    select(byId("leaf"));
    expect(pageSelection()?.cells).toEqual([
      {
        name: "rose",
        state: "fresh",
        loc: "src/model/rose.ts:9",
        file: "src/model/rose.ts",
        line: 9,
      },
      {
        name: "analysis",
        state: "stale",
        loc: "src/model/graph.ts:31",
        file: "src/model/graph.ts",
        line: 31,
      },
    ]);
  });

  it("recovers TeX from the data-tex stamp", () => {
    select(byId("math"));
    expect(pageSelection()?.tex).toBe("x^2");
  });

  it("honours maxChars, depth and source: false", () => {
    select(byId("leaf"));
    const s = pageSelection({ maxChars: 6, depth: 1, source: false });
    expect(s).toMatchObject({ text: "petals", chars: 17, truncated: true });
    expect(s?.elements).toEqual([{ tag: "p" }]);
    expect(s?.cells).toEqual([{ name: "rose" }]);
  });

  it("renders the selected fragment as markdown on request", () => {
    select(byId("leaf"), byId("k"));
    const s = pageSelection({ format: "markdown" });
    // The fragment ends inside the row, so the row ends with the selected cell.
    expect(s?.markdown).toBe("petals and thorns\n\n| k | v |\n| --- | --- |\n| kappa |");
  });

  it("includes client rects only on request ([] where Range.getClientRects is absent)", () => {
    select(byId("leaf"));
    expect(pageSelection()?.rects).toBeUndefined();
    expect(pageSelection({ rects: true })?.rects).toEqual([]);
  });

  it("remembers the last selection across a focus steal, then forgets it after the TTL", () => {
    vi.useFakeTimers();
    select(byId("leaf"));
    expect(pageSelection()?.live).toBe(true);
    window.getSelection()?.removeAllRanges(); // focus moved into a textarea
    expect(pageSelection()).toMatchObject({ text: "petals and thorns", live: false });
    vi.advanceTimersByTime(SELECTION_TTL_MS + 1);
    expect(pageSelection()).toBeNull();
  });

  it("never treats a selection inside agent chrome as one", () => {
    select(byId("chrome"));
    expect(pageSelection()).toBeNull();
  });

  it("describeRange works on any range, stamped by the caller", () => {
    const range = document.createRange();
    range.selectNodeContents(byId("leaf"));
    expect(describeRange(range, {}, { at: 7, live: false })).toMatchObject({
      text: "petals and thorns",
      at: 7,
      live: false,
    });
  });
});
