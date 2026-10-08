// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { AGENT_CHROME_ATTR, pageText, texOfElement } from "./page-text";

const mount = (html: string): HTMLElement => {
  document.body.innerHTML = html;
  return document.body;
};

describe("pageText", () => {
  it("renders headings, prose, lists and tables as Markdown-shaped text, with the outline", () => {
    mount(`
      <main>
        <h1>seismos · the shape of global seismicity</h1>
        <p>Every   M≥4.5 earthquake, <strong>269,952</strong> of them.</p>
        <h2>the observatory</h2>
        <ul><li>brush the <em>map</em></li><li>pick a depth class<ul><li>shallow</li><li>deep</li></ul></li></ul>
        <ol><li>first</li><li>second</li></ol>
        <table><thead><tr><th>field</th><th>value</th></tr></thead>
          <tbody><tr><td>b-value</td><td>0.87 | 0.002</td></tr></tbody></table>
      </main>`);
    const out = pageText();
    expect(out.text).toBe(
      [
        "# seismos · the shape of global seismicity",
        "",
        "Every M≥4.5 earthquake, 269,952 of them.",
        "",
        "## the observatory",
        "",
        "- brush the map",
        "- pick a depth class",
        "  - shallow",
        "  - deep",
        "",
        "1. first",
        "2. second",
        "",
        "| field | value |",
        "| --- | --- |",
        "| b-value | 0.87 \\| 0.002 |",
      ].join("\n"),
    );
    expect(out.headings).toEqual([
      { level: 1, text: "seismos · the shape of global seismicity" },
      { level: 2, text: "the observatory" },
    ]);
    expect(out.truncated).toBe(false);
    expect(out.chars).toBe(out.text.length);
  });

  it("emits stamped math as TeX — inline $…$, display $$…$$ — and never KaTeX's duplicate halves", () => {
    mount(`
      <p>The law is
        <span class="math-inline" data-tex="\\log_{10} N = a - bM"><span class="katex"><span class="katex-mathml"><math><semantics><mrow><mi>N</mi></mrow><annotation encoding="application/x-tex">\\log_{10} N = a - bM</annotation></semantics></math></span><span class="katex-html" aria-hidden="true"><span>log</span><span>N</span></span></span></span>
        with b near 1.</p>
      <div class="math-display" data-tex="N(\\ge M) = 10^{a-bM}"><span class="katex-display"><span class="katex">rendered</span></span></div>
      <p>A bare KaTeX node: <span class="katex"><span class="katex-mathml"><math><semantics><mrow/><annotation encoding="application/x-tex">x^2</annotation></semantics></math></span><span class="katex-html" aria-hidden="true">x2</span></span>.</p>`);
    const out = pageText();
    expect(out.text).toBe(
      [
        "The law is $\\log_{10} N = a - bM$ with b near 1.",
        "",
        "$$N(\\ge M) = 10^{a-bM}$$",
        "",
        "A bare KaTeX node: $x^2$.",
      ].join("\n"),
    );
  });

  it("skips scripts, hidden and aria-hidden elements, media, and the agent chrome", () => {
    mount(`
      <p>visible</p>
      <script>var x = 1;</script><style>p{}</style>
      <p hidden>hidden</p><p aria-hidden="true">assistive duplicate</p>
      <svg><text>tick 1</text></svg><canvas></canvas>
      <aside ${AGENT_CHROME_ATTR}=""><h2>calls (2)</h2><p>channel report</p></aside>
      <p>also visible <img alt="the Ring of Fire"> <a href="/x">a link</a></p>`);
    const out = pageText();
    expect(out.text).toBe("visible\n\nalso visible [image: the Ring of Fire] a link");
    expect(out.headings).toEqual([]);
  });

  it("fences pre blocks verbatim and inlines code; blockquotes are quoted", () => {
    mount(`
      <p>Use <code>registerSqlTools(kit)</code>:</p>
      <pre>const a = 1;\n  const b = 2;\n</pre>
      <blockquote><p>one</p><p>two</p></blockquote>`);
    expect(pageText().text).toBe(
      [
        "Use `registerSqlTools(kit)`:",
        "",
        "```",
        "const a = 1;",
        "  const b = 2;",
        "```",
        "",
        "> one",
        ">",
        "> two",
      ].join("\n"),
    );
  });

  it("reads form state: inputs, checkboxes, selects", () => {
    mount(`
      <label>Mc <input type="number" value="4.7"></label>
      <label><input type="checkbox" checked> deep only</label>
      <select><option>mww</option><option selected>mb</option></select>`);
    expect(pageText().text).toBe("Mc 4.7 [x] deep only mb");
  });

  it("windows the rendering by offset and maxChars, and reports the whole", () => {
    mount("<p>abcdefghij</p><p>klmnopqrst</p>");
    const whole = pageText();
    expect(whole.text).toBe("abcdefghij\n\nklmnopqrst");
    const first = pageText({ maxChars: 10 });
    expect(first).toMatchObject({ text: "abcdefghij", chars: 22, truncated: true });
    const rest = pageText({ maxChars: 10, offset: 12 });
    expect(rest).toMatchObject({ text: "klmnopqrst", truncated: false });
    expect(pageText({ root: document.querySelector("p:last-child") }).text).toBe("klmnopqrst");
    expect(pageText({ root: null }).text).toBe("");
  });
});

describe("texOfElement", () => {
  it("prefers the data-tex stamp, falls back to KaTeX's annotation, else undefined", () => {
    mount(`
      <span data-tex="a+b"><span class="katex"><annotation encoding="application/x-tex">wrong</annotation><i id="in-stamp"></i></span></span>
      <span class="katex"><span class="katex-mathml"><annotation encoding="application/x-tex">c+d</annotation></span><b id="in-katex"></b></span>
      <p id="plain">text</p>`);
    expect(texOfElement(document.getElementById("in-stamp"))).toBe("a+b");
    expect(texOfElement(document.getElementById("in-katex"))).toBe("c+d");
    expect(texOfElement(document.getElementById("plain"))).toBeUndefined();
    expect(texOfElement(null)).toBeUndefined();
  });
});
