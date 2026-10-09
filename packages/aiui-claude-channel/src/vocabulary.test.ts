/**
 * The vocabulary guard: every bracket marker and XML sidecar the lowering
 * renderers emit, and every preamble marker, is taught by the MCP server's
 * INSTRUCTIONS. The two were written by hand in two places and nothing
 * checked them (docs/proposals/prompt-sites.md, pattern 9); this does.
 */

import { join } from "node:path";
import { composeIntent, Engine } from "@habemus-papadum/aiui-lowering-pipeline";
import { describe, expect, it } from "vitest";
import { promptContextSections, TRANSCRIPTION_NOTE } from "./prompt-context";
import { INSTRUCTIONS } from "./server";

function renderedVocabulary(): string {
  let t = 0;
  const engine = new Engine({}, () => ++t);
  engine.setArmed(true);
  engine.transcriptFinal(engine.talkStart() ?? 1, "make the legend wider", 90, "mock");
  engine.shotDone(
    { x: 1, y: 2, w: 30, h: 20 },
    [
      {
        component: "Legend",
        source: "src/Legend.tsx:30:2",
        rect: { x: 0, y: 0, w: 10, h: 10 },
        cells: [{ name: "legend/entries", source: "src/Legend.tsx:12:4" }],
      },
    ],
    undefined,
    "/tmp/aiui/shots/shot_1.png",
  );
  engine.appSelection({ text: "E = mc^2", sourceLoc: "src/E.tsx:4:2", tex: "E = mc^2" });
  engine.codeSelection({ text: "const a = 1;", sourceLoc: "src/a.ts:1:1" });
  engine.codeSelection({
    text: Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n"),
    sourceLoc: "src/long.ts:1:1",
    lines: 60,
  });
  engine.shotDone(
    { x: 0, y: 0, w: 8, h: 8 },
    [],
    undefined,
    "/tmp/p.png",
    undefined,
    undefined,
    undefined,
    "paste",
  );
  engine.shotDone({ x: 0, y: 0, w: 8, h: 8 }, []);
  engine.navigation("http://a/", "http://a/b", "push", { url: "http://a/b", title: "B" });
  engine.tabSwitch("http://a/b", "http://c/", 1, 2, { url: "http://c/", title: "C" });
  const body = composeIntent(engine.events, "replace").prompt;
  const preamble = promptContextSections({
    tab: { url: "http://a/", title: "A", chromeTabId: 1 },
    source: { root: "/repo/app" },
  } as never).join("\n\n");
  return `${preamble}\n\n${TRANSCRIPTION_NOTE}\n\n${body}`;
}

describe("the prompt vocabulary is taught by INSTRUCTIONS", () => {
  const rendered = renderedVocabulary();

  // A marker's head as the renderer writes it → the phrase INSTRUCTIONS teaches.
  const MARKERS: ReadonlyArray<readonly [head: string, taught: string]> = [
    ["[screenshot", "[screenshot located at"],
    ["[pasted image", "[pasted image located at"],
    ["[selected text:", "[selected text:"],
    ["[code selection at", "[code selection at"],
    ["[current page changed:", "[current page changed:"],
    ["[current tab changed:", "[current tab changed:"],
    ["[current tab:", "[current tab:"],
  ];

  it("every bracket marker the renderers emit is one INSTRUCTIONS teaches, and each is exercised", () => {
    for (const [head, taught] of MARKERS) {
      expect(rendered, head).toContain(head);
      expect(INSTRUCTIONS, taught).toContain(taught);
    }
    // A marker this list does not know fails here: every `[` the sample
    // opens must start one of the heads above (the fenced code holds none).
    for (let at = rendered.indexOf("["); at !== -1; at = rendered.indexOf("[", at + 1)) {
      const known = MARKERS.some(([head]) => rendered.startsWith(head, at));
      expect(known, rendered.slice(at, at + 40)).toBe(true);
    }
    expect(rendered).toContain("MISSING");
    expect(INSTRUCTIONS).toContain("MISSING");
    expect(rendered).toMatch(/\(\d+ lines\)/);
    expect(INSTRUCTIONS).toContain("(N lines)");
  });

  it("every XML sidecar element the renderers emit", () => {
    const tags = new Set<string>();
    for (const m of rendered.matchAll(/<([a-z][a-z-]*)[\s/>]/g)) tags.add(`<${m[1]}`);
    expect([...tags].sort()).toEqual([
      "<cell",
      "<element",
      "<screenshot-metadata",
      "<selection-metadata",
      "<tab",
    ]);
    for (const tag of tags) expect(INSTRUCTIONS).toContain(tag);
  });

  it("the sample itself, in the corpus", async () => {
    await expect(rendered).toMatchFileSnapshot(
      join(__dirname, "..", "corpus", "vocabulary-sample.txt"),
    );
  });
});
