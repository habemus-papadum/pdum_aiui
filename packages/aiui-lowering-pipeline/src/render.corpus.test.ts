/**
 * The CORPUS: what the lowering pipeline renders today, written out as readable
 * files under ../corpus/ so the prompt-toolkit migration has a baseline to
 * measure itself against (docs/proposals/structured-prompts-review.md, "golden
 * corpora"). A baseline, not a contract: a renderer change updates these files
 * with `vitest -u` and the diff is reviewed like any other.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { composeIntent } from "./compose";
import { Engine } from "./engine";
import type { IntentEvent } from "./types";

const fixturesDir = `${join(__dirname, "..", "fixtures")}/`;
const corpus = (name: string): string => join(__dirname, "..", "corpus", name);

/**
 * One synthetic turn that exercises every marker and sidecar the renderers
 * emit: a transcript with a framed shot (elements and cells), a pasted
 * image, a shot whose pixels were never captured, an app selection with TeX
 * and a cell, a short and a long code selection, a navigation and a tab
 * switch. The channel's vocabulary test renders the same stream.
 */
export function allMarkersStream(): IntentEvent[] {
  let t = 0;
  const engine = new Engine({}, () => ++t);
  engine.setArmed(true);
  const seg1 = engine.talkStart() ?? 1;
  engine.transcriptFinal(seg1, "make the legend wider", 90, "mock");
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
  engine.appSelection({
    text: "E = mc^2",
    sourceLoc: "src/Energy.tsx:4:2",
    tex: "E = mc^2",
    cell: "energy/total",
    cellLoc: "src/Energy.tsx:3:1",
    url: "http://localhost:5173/",
  });
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
    "/tmp/aiui/shots/paste_1.png",
    undefined,
    undefined,
    undefined,
    "paste",
  );
  engine.shotDone({ x: 0, y: 0, w: 8, h: 8 }, []);
  engine.navigation("http://localhost:5173/", "http://localhost:5173/seismos", "push", {
    url: "http://localhost:5173/seismos",
    title: "seismos",
    aiui: true,
  });
  engine.tabSwitch("http://localhost:5173/seismos", "https://example.com/docs", 1, 2, {
    url: "https://example.com/docs",
    title: "Docs",
  });
  const seg2 = engine.talkStart() ?? 2;
  engine.transcriptFinal(seg2, "and match the docs", 90, "mock");
  return engine.events;
}

describe("corpus: the rendered prompt body", () => {
  const files = readdirSync(fixturesDir)
    .filter((f) => f.endsWith(".json"))
    .sort();

  it.each(files)("%s", async (file) => {
    const events = JSON.parse(readFileSync(`${fixturesDir}${file}`, "utf8")) as IntentEvent[];
    const composed = composeIntent(events, "replace");
    await expect(composed.prompt).toMatchFileSnapshot(corpus(file.replace(/\.json$/, ".txt")));
  });

  it("every marker and sidecar, in one synthetic turn — with its spans", async () => {
    const composed = composeIntent(allMarkersStream(), "replace");
    await expect(composed.prompt).toMatchFileSnapshot(corpus("all-markers.txt"));
    await expect(JSON.stringify(composed.spans, null, 2)).toMatchFileSnapshot(
      corpus("all-markers.spans.json"),
    );
    // Under the `note` policy a correction renders as an instruction.
    const noted = composeIntent(allMarkersStream(), "note");
    expect(noted.prompt).toBe(composed.prompt); // no corrections in this stream
  });
});
