/**
 * catalog.test.ts — the parser over the REAL catalog file, and the contract
 * between the catalog and this page: every specimen key names a row that
 * exists, every section the page hangs something on exists.
 */
import { describe, expect, it } from "vitest";
import {
  allPieceRows,
  isPieceTable,
  parseCatalog,
  parseState,
  pieceKey,
  rewriteLinks,
  slugify,
  tableCells,
} from "./catalog";
import { CATALOG_MD, CATALOG_URL } from "./catalog-source";
import { SECTION_SPECIMEN_IDS, SPECIMEN_KEYS } from "./specimen-keys";

const BASE = CATALOG_URL;
const DOC = parseCatalog(rewriteLinks(CATALOG_MD, BASE));

describe("the pieces", () => {
  it("slugs headings the way GitHub anchors them", () => {
    expect(slugify("6. Adding a piece")).toBe("6-adding-a-piece");
    expect(slugify("2.1 Controls and cells in the prose and the chrome")).toBe(
      "21-controls-and-cells-in-the-prose-and-the-chrome",
    );
    expect(slugify("Attention: hover, marks, notes, knobs, the lens")).toBe(
      "attention-hover-marks-notes-knobs-the-lens",
    );
  });

  it("keys a row by its first code span, else its slug", () => {
    expect(pieceKey("`cell`, `cellGraph`, `cellRegistry`, `settledOnly`")).toBe("cell");
    expect(pieceKey("`ControlScrub` — the scrub pill")).toBe("ControlScrub");
    expect(pieceKey("the modal kit, `solidModeEngine`")).toBe("solidModeEngine");
    expect(pieceKey("the page")).toBe("the-page");
    expect(pieceKey("vendor keys")).toBe("vendor-keys");
  });

  it("reads the state cell's primary word and keeps the full label", () => {
    expect(parseState("shipped")).toEqual({ primary: "shipped", label: "shipped" });
    expect(parseState("spike (the pill is shipped)")).toEqual({
      primary: "spike",
      label: "spike (the pill is shipped)",
    });
    expect(parseState("proposed")).toEqual({ primary: "proposed", label: "proposed" });
    expect(parseState("—").primary).toBeUndefined();
  });

  it("splits table cells and unescapes pipes", () => {
    expect(tableCells("| a | `b` | c \\| d |")).toEqual(["a", "`b`", "c | d"]);
    expect(isPieceTable(["Piece", "What it is", "Where", "State", "Seen in"])).toBe(true);
    expect(isPieceTable(["Container", "What it holds", "Where", "State", "Seen in"])).toBe(true);
    expect(isPieceTable(["Tool", "What it answers", "Group"])).toBe(false);
  });

  it("rewrites relative links against the file's GitHub URL and leaves the rest", () => {
    const out = rewriteLinks(
      "[a](./README.md) [b](../../demos/twins) [c](#6-adding-a-piece) [d](https://x.y/)",
      BASE,
    );
    expect(out).toBe(
      "[a](https://github.com/habemus-papadum/pdum_aiui/blob/main/packages/aiui-viz/README.md) " +
        "[b](https://github.com/habemus-papadum/pdum_aiui/blob/main/demos/twins) " +
        "[c](#6-adding-a-piece) [d](https://x.y/)",
    );
  });
});

describe("the real catalog", () => {
  it("has the title, the five shelves and the rule for adding a piece", () => {
    expect(DOC.title).toMatch(/^The catalog/);
    const ids = DOC.sections.map((s) => s.id);
    expect(ids).toEqual([
      "how-to-read-an-entry",
      "1-the-substrate",
      "2-components",
      "3-containers",
      "4-the-agent-surface",
      "5-sister-packages-in-this-repo",
      "6-adding-a-piece",
    ]);
  });

  it("draws its shape with a mermaid fence under 'how to read an entry'", () => {
    const howTo = DOC.sections.find((s) => s.id === "how-to-read-an-entry");
    const fence = howTo?.blocks.find((b) => b.kind === "code");
    expect(fence?.kind === "code" && fence.lang).toBe("mermaid");
    expect(fence?.kind === "code" && fence.text).toContain("flowchart");
  });

  it("the components shelf carries its sub-shelves as heading blocks", () => {
    const components = DOC.sections.find((s) => s.id === "2-components");
    const subs = components?.blocks.filter((b) => b.kind === "heading").map((b) => b.text) ?? [];
    expect(subs[0]).toMatch(/^2\.1 /);
    expect(subs).toHaveLength(8);
  });

  it("every piece row has a name, a state and a where", () => {
    const rows = allPieceRows(DOC);
    expect(rows.length).toBeGreaterThan(30);
    for (const r of rows) {
      expect(r.name, r.key).not.toBe("");
      expect(r.where, r.key).not.toBe("");
      expect(r.state.primary, `${r.key}: "${r.state.label}"`).toBeDefined();
    }
    // The keys are the domain specimens attach to: they must be unique.
    const keys = rows.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("no relative link survives the rewrite", () => {
    const flat = JSON.stringify(DOC);
    expect(flat).not.toMatch(/\]\(\.{1,2}\//);
  });

  it("every specimen key names a row, and every section specimen a section", () => {
    const keys = new Set(allPieceRows(DOC).map((r) => r.key));
    for (const k of SPECIMEN_KEYS)
      expect(keys.has(k), `specimen "${k}" has no catalog row`).toBe(true);
    const ids = new Set(DOC.sections.map((s) => s.id));
    for (const id of SECTION_SPECIMEN_IDS)
      expect(ids.has(id), `section "${id}" missing`).toBe(true);
  });
});
