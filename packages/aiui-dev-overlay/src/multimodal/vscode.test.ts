// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { cellChain, cellSourceLoc, elementChain, jumpTargets, vscodeFileUrl } from "./vscode";

/** Build a small annotated tree and return the deepest (click-target) leaf. */
function tree(html: string, leafSelector: string): Element {
  document.body.innerHTML = html;
  const leaf = document.body.querySelector(leafSelector);
  if (!leaf) {
    throw new Error(`no ${leafSelector} in fixture`);
  }
  return leaf;
}

const ROOT = "/home/me/app";

describe("elementChain (stamped ancestors, nearest → outermost)", () => {
  it("walks outward from the unstamped click target, nearest stamp first", () => {
    const leaf = tree(
      `<div data-source-loc="src/App.tsx:5:3">
         <section data-source-loc="src/Panel.tsx:12:5"><span id="leaf">text</span></section>
       </div>`,
      "#leaf",
    );
    const chain = elementChain(leaf, ROOT);
    expect(chain.map((t) => [t.label, t.loc])).toEqual([
      ["section", "src/Panel.tsx:12:5"],
      ["div", "src/App.tsx:5:3"],
    ]);
    expect(chain[0].url).toBe("vscode://file/home/me/app/src/Panel.tsx:12:5");
    expect(chain.every((t) => t.kind === "element")).toBe(true);
  });

  it("is empty when nothing on or around the target is stamped", () => {
    const leaf = tree(`<div><span id="leaf">bare</span></div>`, "#leaf");
    expect(elementChain(leaf, ROOT)).toEqual([]);
  });

  it("caps the chain at five targets", () => {
    const nested = Array.from({ length: 8 }, (_, i) => `<div data-source-loc="src/L${i}.tsx:1:1">`)
      .join("")
      .concat(`<i id="leaf"></i>`, "</div>".repeat(8));
    const chain = elementChain(tree(nested, "#leaf"), ROOT);
    expect(chain).toHaveLength(5);
    expect(chain[0].loc).toBe("src/L7.tsx:1:1"); // innermost stamp first
  });

  it("carries no url when the stamp is relative and the root is unknown", () => {
    const leaf = tree(`<div data-source-loc="src/App.tsx:5:3" id="leaf"></div>`, "#leaf");
    const [target] = elementChain(leaf, undefined);
    expect(target.loc).toBe("src/App.tsx:5:3");
    expect(target.url).toBeUndefined();
  });
});

describe("cellChain (containing cells, nearest → outermost, at definition sites)", () => {
  it("lists nested cells nearest-first, each at its data-cell-loc definition", () => {
    const leaf = tree(
      `<div data-cell="dashboard" data-cell-loc="src/model.ts:10">
         <div data-cell="catalog" data-cell-loc="src/model.ts:20">
           <span id="leaf">point</span>
         </div>
       </div>`,
      "#leaf",
    );
    const chain = cellChain(leaf, ROOT);
    expect(chain.map((t) => [t.label, t.loc])).toEqual([
      ["catalog", "src/model.ts:20"],
      ["dashboard", "src/model.ts:10"],
    ]);
    expect(chain[1].url).toBe("vscode://file/home/me/app/src/model.ts:10");
    expect(chain.every((t) => t.kind === "cell")).toBe(true);
  });

  it("keeps a cell with no resolvable stamp — loc/url absent, so the picker can NAME it", () => {
    const leaf = tree(`<div data-cell="mystery"><span id="leaf">x</span></div>`, "#leaf");
    const chain = cellChain(leaf, ROOT);
    expect(chain).toHaveLength(1);
    expect(chain[0]).toMatchObject({ kind: "cell", label: "mystery" });
    expect(chain[0].loc).toBeUndefined();
    expect(chain[0].url).toBeUndefined();
  });

  it("ignores empty data-cell stamps and is empty without any cell", () => {
    const leaf = tree(`<div data-cell=""><span id="leaf">x</span></div>`, "#leaf");
    expect(cellChain(leaf, ROOT)).toEqual([]);
  });
});

describe("cellSourceLoc (definition site first, then the shot locator's approximation)", () => {
  it("prefers data-cell-loc (the cell() call) over any JSX stamp", () => {
    const cell = tree(
      `<div id="cell" data-cell="catalog" data-cell-loc="src/model.ts:20"
            data-source-loc="src/View.tsx:8:3"><i data-source-loc="src/View.tsx:9:5"></i></div>`,
      "#cell",
    );
    expect(cellSourceLoc(cell)).toBe("src/model.ts:20");
  });

  it("resolves a bare manual data-cell name through the live registry bridge", () => {
    // The one MANUAL attribution attribute: a non-CellView render declares
    // `data-cell="name"` (no loc — names can't drift, locations can). aiui-viz
    // mirrors name→loc at window.__aiuiCells; the ladder consults it before
    // falling back to JSX-stamp approximations. This replaced the retired
    // runtime-internals attribution spike at zero brittleness.
    (window as unknown as { __aiuiCells?: unknown }).__aiuiCells = {
      loc: (name: string) => (name === "grStats" ? "src/model/graph.ts:31" : undefined),
    };
    try {
      const manual = tree(
        `<div id="cell" data-cell="grStats" data-source-loc="src/View.tsx:8:3"></div>`,
        "#cell",
      );
      expect(cellSourceLoc(manual)).toBe("src/model/graph.ts:31"); // registry beats JSX stamp
      // Explicit data-cell-loc still wins over the registry…
      const stamped = tree(
        `<div id="cell" data-cell="grStats" data-cell-loc="src/other.ts:9"></div>`,
        "#cell",
      );
      expect(cellSourceLoc(stamped)).toBe("src/other.ts:9");
      // …and a name the registry doesn't know falls through the ladder.
      const unknown = tree(
        `<div id="cell" data-cell="mystery" data-source-loc="src/View.tsx:8:3"></div>`,
        "#cell",
      );
      expect(cellSourceLoc(unknown)).toBe("src/View.tsx:8:3");
      // A broken bridge must never break attribution.
      (window as unknown as { __aiuiCells?: unknown }).__aiuiCells = {
        loc: () => {
          throw new Error("boom");
        },
      };
      expect(cellSourceLoc(unknown)).toBe("src/View.tsx:8:3");
    } finally {
      delete (window as unknown as { __aiuiCells?: unknown }).__aiuiCells;
    }
  });

  it("falls back to the element's own stamp, then the first stamped descendant", () => {
    const own = tree(
      `<div id="cell" data-cell="c" data-source-loc="src/View.tsx:8:3"></div>`,
      "#cell",
    );
    expect(cellSourceLoc(own)).toBe("src/View.tsx:8:3");
    const descendant = tree(
      `<div id="cell" data-cell="c"><p><b data-source-loc="src/Inner.tsx:4:1"></b></p></div>`,
      "#cell",
    );
    expect(cellSourceLoc(descendant)).toBe("src/Inner.tsx:4:1");
    const bare = tree(`<div id="cell" data-cell="c"><p></p></div>`, "#cell");
    expect(cellSourceLoc(bare)).toBeUndefined();
  });
});

describe("vscodeFileUrl (the on-the-fly deep link)", () => {
  it("absolutizes a relative stamp against the source root (trailing slash or not)", () => {
    expect(vscodeFileUrl("src/App.tsx:5:3", "/home/me/app")).toBe(
      "vscode://file/home/me/app/src/App.tsx:5:3",
    );
    expect(vscodeFileUrl("src/App.tsx:5:3", "/home/me/app/")).toBe(
      "vscode://file/home/me/app/src/App.tsx:5:3",
    );
  });

  it("passes an already-absolute stamp through and encodes spaces", () => {
    expect(vscodeFileUrl("/abs/path/File.tsx:1:1", undefined)).toBe(
      "vscode://file/abs/path/File.tsx:1:1",
    );
    expect(vscodeFileUrl("src/My File.tsx:2:1", "/root")).toBe(
      "vscode://file/root/src/My%20File.tsx:2:1",
    );
  });

  it("is undefined for a relative stamp with no known root — VS Code can't open it", () => {
    expect(vscodeFileUrl("src/App.tsx:5:3", undefined)).toBeUndefined();
    expect(vscodeFileUrl("src/App.tsx:5:3", "")).toBeUndefined();
  });
});

describe("jumpTargets (both chains at once — what the picker receives)", () => {
  it("elements and cells stay separate groups, both nearest-first", () => {
    const leaf = tree(
      `<main data-source-loc="src/App.tsx:3:1">
         <div data-cell="dashboard" data-cell-loc="src/model.ts:10">
           <section data-source-loc="src/Panel.tsx:12:5">
             <span id="leaf" data-source-loc="src/Panel.tsx:14:9">x</span>
           </section>
         </div>
       </main>`,
      "#leaf",
    );
    const targets = jumpTargets(leaf, ROOT);
    expect(targets.elements.map((t) => t.loc)).toEqual([
      "src/Panel.tsx:14:9",
      "src/Panel.tsx:12:5",
      "src/App.tsx:3:1",
    ]);
    expect(targets.cells.map((t) => [t.label, t.loc])).toEqual([["dashboard", "src/model.ts:10"]]);
  });
});
