import { describe, expect, it } from "vitest";
import { buildSourceTree, highlightLines, languageFor, splitHighlighted } from "./source-tree";
import { combinedStatus } from "./status";

describe("buildSourceTree", () => {
  it("nests by directory, directories first, a climbing path under `..`", () => {
    const tree = buildSourceTree([
      "src/ui/App.tsx",
      "src/main.tsx",
      "vite.config.ts",
      "../seismos/src/ui/App.tsx",
      "src/ui/app.css",
    ]);
    expect(tree.map((n) => n.name)).toEqual(["..", "src", "vite.config.ts"]);
    const src = tree[1];
    expect(src?.children?.map((n) => n.name)).toEqual(["ui", "main.tsx"]);
    // Locale order: case-insensitive, as a file tree reads best.
    expect(src?.children?.[0]?.children).toEqual([
      { name: "app.css", path: "src/ui/app.css" },
      { name: "App.tsx", path: "src/ui/App.tsx" },
    ]);
    expect(tree[0]?.children?.[0]?.name).toBe("seismos");
  });
});

describe("languageFor", () => {
  it("maps the extensions an aiui app has, and nothing else", () => {
    expect(languageFor("src/a.tsx")).toBe("typescript");
    expect(languageFor("x.mjs")).toBe("javascript");
    expect(languageFor("site.css")).toBe("css");
    expect(languageFor("package.json")).toBe("json");
    expect(languageFor("README.md")).toBe("markdown");
    expect(languageFor("index.html")).toBe("xml");
    expect(languageFor("data.csv")).toBeUndefined();
  });
});

describe("splitHighlighted", () => {
  it("closes spans at a line's end and reopens them on the next", () => {
    const html = '<span class="hljs-comment">/* a\nb */</span> <span class="k">x</span>';
    expect(splitHighlighted(html)).toEqual([
      '<span class="hljs-comment">/* a</span>',
      '<span class="hljs-comment">b */</span> <span class="k">x</span>',
    ]);
  });
  it("leaves balanced lines alone", () => {
    expect(splitHighlighted("a\n<span>b</span>\nc")).toEqual(["a", "<span>b</span>", "c"]);
  });
});

describe("highlightLines", () => {
  it("escapes when there is no highlighter, dropping one trailing newline", () => {
    expect(highlightLines("a < b\n", "x.csv", undefined)).toEqual(["a &lt; b"]);
  });
  it("highlights through the loaded grammars", async () => {
    const { loadHighlighter } = await import("./source-tree");
    const hljs = await loadHighlighter();
    const lines = highlightLines('const s = "x"; // hi\nlet n = 1;', "a.ts", hljs);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('class="hljs-keyword">const');
    expect(lines[0]).toContain("hljs-string");
    expect(lines[0]).toContain("hljs-comment");
    expect(lines[1]).toContain("hljs-number");
  });
});

describe("combinedStatus", () => {
  it("picks the most urgent status", () => {
    expect(combinedStatus("idle", "idle")).toBe("idle");
    expect(combinedStatus("idle", "parked")).toBe("parked");
    expect(combinedStatus("live", "connecting")).toBe("connecting");
    expect(combinedStatus("error", "live")).toBe("error");
    expect(combinedStatus()).toBe("idle");
    expect(combinedStatus("weird")).toBe("idle");
  });
});
