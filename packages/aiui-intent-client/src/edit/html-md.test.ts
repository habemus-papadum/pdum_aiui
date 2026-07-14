// @vitest-environment jsdom
/**
 * html-md.test.ts — the rich-paste conversion: common clipboard shapes come
 * out as Markdown; markup-free HTML signals "use the plain-text lane".
 */
import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "./html-md";

describe("htmlToMarkdown", () => {
  it("converts the common inline shapes", () => {
    expect(htmlToMarkdown("<p>a <strong>bold</strong> and <em>italic</em> word</p>")).toBe(
      "a **bold** and *italic* word",
    );
    expect(htmlToMarkdown('<p>see <a href="https://x.test/doc">the doc</a></p>')).toBe(
      "see [the doc](https://x.test/doc)",
    );
    expect(htmlToMarkdown("<p>run <code>pnpm test</code> now</p>")).toBe("run `pnpm test` now");
  });

  it("converts blocks: headings, lists, quotes, fences", () => {
    expect(htmlToMarkdown("<h2>Title</h2><p>body</p>")).toBe("## Title\n\nbody");
    expect(htmlToMarkdown("<ul><li>one</li><li>two</li></ul>")).toBe("- one\n- two");
    expect(htmlToMarkdown("<ol><li>first</li><li>second</li></ol>")).toBe("1. first\n2. second");
    expect(htmlToMarkdown("<blockquote>wise words</blockquote>")).toBe("> wise words");
    expect(htmlToMarkdown("<pre>const x = 1;\nconst y = 2;</pre>")).toBe(
      "```\nconst x = 1;\nconst y = 2;\n```",
    );
  });

  it("signals the plain-text lane when nothing would be gained", () => {
    expect(htmlToMarkdown("<div>just words, no markup</div>")).toBeUndefined();
    expect(htmlToMarkdown("")).toBeUndefined();
  });

  it("drops script/style and survives unknown tags by keeping their text", () => {
    expect(htmlToMarkdown("<article>kept <script>evil()</script><b>bold</b></article>")).toBe(
      "kept **bold**",
    );
  });
});
