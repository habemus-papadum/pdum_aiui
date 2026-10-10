// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { exampleRecord } from "../bench/fixtures.ts";
import { bindBenchTheme } from "../bench/theme.ts";
import { mountComparison, mountInspector } from "./view.tsx";

const directory = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(resolve(directory, path), "utf8");
const base = read("./style.css");
const docs = read("../../aiui-prompts/docs/theming.md");
const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  document.body.replaceChildren();
  for (const style of document.head.querySelectorAll("style")) style.remove();
});

// Inspect the parsed stylesheet contract, not jsdom's computed custom properties.
function styleRules(css: string): CSSStyleRule[] {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  if (!style.sheet) throw new Error("Stylesheet failed to parse");
  const collect = (rules: CSSRuleList): CSSStyleRule[] =>
    [...rules].flatMap((rule) => {
      if ("selectorText" in rule) return [rule as CSSStyleRule];
      return "cssRules" in rule ? collect((rule as CSSMediaRule).cssRules) : [];
    });
  return collect(style.sheet.cssRules);
}

describe("inspector stylesheet contract", () => {
  it("has neutral, scoped, zero-specificity rules and never shadows inherited public tokens", () => {
    const rules = styleRules(base);
    expect(rules.length).toBeGreaterThan(20);
    expect(base).not.toContain("--aiui-");
    expect(base).not.toContain("@import");
    for (const rule of rules) {
      expect(rule.selectorText).toMatch(/^:where\([\s\S]+\)(?:::backdrop)?$/);
      expect(rule.selectorText).toMatch(/\.prompt-(?:inspector|comparison)/);
      for (let index = 0; index < rule.style.length; index++)
        expect(rule.style[index]).not.toMatch(/^--prompt-/);
    }
    // Every public read has an inline fallback, and every consumed token is documented.
    const tokens = [...base.matchAll(/var\((--prompt-[a-z-]+)(\s*,)?/g)];
    for (const token of tokens) {
      expect(token[2], token[1]).toBe(",");
      expect(docs).toContain(`\`${token[1]}\``);
    }
    const outside = document.createElement("section");
    outside.innerHTML =
      '<h3>Host title</h3><button>Host button</button><div class="prompt-panels"><code>Host code</code></div>';
    document.body.append(outside);
    for (const node of outside.querySelectorAll("*"))
      for (const rule of rules) expect(node.matches(rule.selectorText)).toBe(false);
  });

  it("keeps theme definitions opt-in and separate from math glyph styling", () => {
    for (const name of ["aiui", "terminal"]) {
      const css = read(`./themes/${name}.css`);
      const rules = styleRules(css);
      expect(rules).toHaveLength(1);
      expect(rules[0].selectorText).toBe(`:where([data-prompt-theme="${name}"])`);
      expect(css).not.toContain("@import");
      for (let index = 0; index < rules[0].style.length; index++) {
        const property = rules[0].style[index];
        expect(property).toMatch(/^--prompt-/);
        expect(base).toContain(`var(${property},`);
      }
      if (name === "terminal") expect(css).not.toContain("--aiui-");
    }
    const host = document.createElement("div");
    document.body.append(host);
    const view = mountInspector(host, exampleRecord());
    disposers.push(view.dispose);
    const glyph = host.querySelector(".katex .mathnormal");
    expect(glyph).not.toBeNull();
    const fontRules = styleRules(base).filter((rule) =>
      /(?:^|;)\s*font(?:-[a-z-]+)?:/.test(rule.style.cssText),
    );
    // The component font rules may style prose ancestors but never a KaTeX glyph itself.
    for (const rule of fontRules) expect(glyph?.matches(rule.selectorText)).toBe(false);
  });

  it("exports each optional stylesheet and marks CSS imports as side effects", () => {
    const manifest = JSON.parse(read("../package.json"));
    expect(manifest.sideEffects).toContain("**/*.css");
    for (const path of ["style.css", "themes/aiui.css", "themes/terminal.css"]) {
      expect(manifest.exports[`./${path}`]).toBe(`./src/${path}`);
      expect(read(`./${path}`).length).toBeGreaterThan(0);
    }
  });

  it.each([
    false,
    true,
  ])("switches wrapper themes without remounting or resetting state (comparison=%s)", (comparison) => {
    const wrapper = document.createElement("div");
    const select = document.createElement("select");
    select.innerHTML =
      '<option value="aiui">aiui</option><option value="neutral">neutral</option><option value="terminal">terminal</option>';
    document.body.append(select, wrapper);
    disposers.push(bindBenchTheme(select, wrapper));
    const mounted = comparison
      ? mountComparison(wrapper, exampleRecord("start"), exampleRecord("refresh"))
      : mountInspector(wrapper, exampleRecord());
    disposers.push(mounted.dispose);
    const views = "before" in mounted ? [mounted.before, mounted.after] : [mounted];
    for (const view of views) {
      const owner = view.controller.compiled?.occurrences.find(
        (item) => item.label === "Kinetic term",
      );
      if (!owner) throw new Error("Missing fixture owner");
      view.controller.select(owner.id);
      view.controller.toggleFold(owner.id);
    }
    const roots = [...wrapper.querySelectorAll(".prompt-inspector")];
    const records = views.map((view) => view.controller.record);
    const compilations = views.map((view) => view.controller.compiled);
    const states = views.map((view) => ({
      selected: view.controller.state.selected,
      folded: [...view.controller.state.contentFolded],
    }));
    const details = wrapper.querySelector<HTMLDetailsElement>("details.prompt-json");
    if (!details) throw new Error("Missing JSON details");
    details.open = true;
    const rawImage = wrapper.querySelector<HTMLButtonElement>(".prompt-raw [data-asset]");
    rawImage?.click();
    const popup = wrapper.querySelector<HTMLElement>(".prompt-image-popup");
    for (const theme of ["terminal", "neutral", "aiui"]) {
      select.value = theme;
      select.dispatchEvent(new Event("change"));
      expect(wrapper.dataset.promptTheme).toBe(theme);
      expect([...wrapper.querySelectorAll(".prompt-inspector")]).toEqual(roots);
      expect(wrapper.querySelector("details.prompt-json")).toBe(details);
      expect(details.open).toBe(true);
      expect(wrapper.querySelector(".prompt-image-popup")).toBe(popup);
      for (const [index, view] of views.entries()) {
        expect(view.controller.record).toBe(records[index]);
        expect(view.controller.compiled).toBe(compilations[index]);
        expect(view.controller.state.selected).toBe(states[index].selected);
        expect([...view.controller.state.contentFolded]).toEqual(states[index].folded);
      }
    }
  });
});
