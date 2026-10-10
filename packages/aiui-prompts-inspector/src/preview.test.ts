import { describe, expect, it } from "vitest";
import { mathPreviewValue, parsePreview, safeImageUrl, safeLink } from "./preview.ts";

describe("original-source Markdown adapter", () => {
  it("retains UTF-16 ranges across entities, escapes, emoji, CRLF, code, and tables", () => {
    const source =
      "# A &amp; B 🧪\r\n\r\nA \\*literal* and `x < y`.\r\n\r\n| a | b |\r\n| - | - |\r\n| 1 | 2 |";
    const document = parsePreview("part-1", source);
    expect(document.nodes.map((node) => node.type)).toEqual(["heading", "paragraph", "table"]);
    const heading = document.nodes[0];
    expect(heading.range).toEqual({ part: "part-1", start: 0, end: source.indexOf("\r\n") });
    expect(heading.children[0].value).toBe("A & B 🧪");
    const table = document.nodes[2];
    expect(source.slice(table.range?.start, table.range?.end)).toBe(
      source.slice(source.indexOf("| a")),
    );
    expect(document.nodes[1].children.some((node) => node.type === "inlineCode")).toBe(true);
  });

  it("provides whole-equation coordinates and does not treat code as mathematics", () => {
    const source = "Inline $x^2$ and `not $math$`.\n\n$$\n\\hat H = \\frac{p^2}{2m}\n$$";
    const document = parsePreview("text", source);
    const inline = document.nodes[0].children.find((node) => node.type === "inlineMath");
    expect(inline?.value).toBe("x^2");
    expect(source.slice(inline?.range?.start, inline?.range?.end)).toBe("$x^2$");
    const display = document.nodes[1];
    expect(display.type).toBe("math");
    expect(display.value).toBe(String.raw`\hat H = \frac{p^2}{2m}`);
    expect(source.slice(display.range?.start, display.range?.end)).toBe(
      source.slice(source.indexOf("$$")),
    );
  });

  it("only allows explicit non-executable preview URLs", () => {
    expect(safeLink("javascript:alert(1)")).toBeUndefined();
    expect(safeLink("/relative-path")).toBeUndefined();
    expect(safeLink("https://example.com/a")).toBe("https://example.com/a");
    expect(safeImageUrl("file:///private/photo.png")).toBeUndefined();
    expect(safeImageUrl("data:image/svg+xml;base64,PHN2Zz4=")).toBeUndefined();
    expect(safeImageUrl("data:image/png;base64,aGVsbG8=")).toBe("data:image/png;base64,aGVsbG8=");
  });

  it("decodes precisely one XML layer only inside a recorded XML semantic region", () => {
    const node = {
      type: "math",
      value: "a &amp;amp; b &lt; c",
      range: { part: "p0", start: 4, end: 30 },
      children: [],
    };
    const region = {
      id: "xml:1",
      kind: "xml" as const,
      occurrence: "o",
      part: "p0",
      start: 0,
      end: 40,
    };
    expect(mathPreviewValue(node, [region])).toEqual({
      value: "a &amp; b < c",
      encoding: "xml-entities-once",
    });
    expect(mathPreviewValue(node, [])).toEqual({ value: node.value, encoding: "literal" });
    expect(mathPreviewValue(node, [{ ...region, part: "p1" }]).value).toBe(node.value);
    expect(mathPreviewValue(node, [{ ...region, end: 20 }]).value).toBe(node.value);
  });
});
