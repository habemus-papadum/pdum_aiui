/**
 * The CORPUS of the tool brief — the one rendering every consumer shares —
 * as readable files under ../corpus/. A baseline for the prompt-toolkit
 * migration, not a contract (docs/proposals/structured-prompts-review.md).
 * `vitest -u` updates; review the diff.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentToolkit } from "./agent-tools";
import { registerStandardTools } from "./standard-tools";
import { type KitDoc, renderToolBrief, type ToolDoc } from "./tool-brief";

const corpus = (name: string): string => join(__dirname, "..", "corpus", name);

/** A seismos-shaped surface: every group, read and write, with usage. */
const seismosLike: KitDoc = {
  ns: "seismos",
  brief:
    "An earthquake catalog (USGS, 1970–2025): a world map, a magnitude histogram and a depth histogram, cross-filtered — brush any view and the others follow. The Gutenberg–Richter fit updates with the filter.",
  tools: [
    {
      name: "report",
      description: "One bounded snapshot of the page's state.",
      usage: "Call first; re-read after a write.",
      kind: "read",
      group: "app",
    },
    {
      name: "set",
      description: "Set one control by name.",
      usage: "Trust the value returned over the one you sent.",
      kind: "write",
      group: "app",
    },
    {
      name: "locate",
      description: "Element → source and cell stamps.",
      kind: "read",
      group: "app",
    },
    { name: "read-page", description: "The page as text.", kind: "read", group: "page" },
    {
      name: "selection",
      description: "What the user selected on the page.",
      usage: "Call when the user says 'this'.",
      kind: "read",
      group: "page",
    },
    {
      name: "cross-filter",
      description: "Set or clear the page's cross-filter dimensions.",
      usage:
        "Dimensions: mag (interval 0–10); depth (interval 0–700 km); year (interval 1970–2025). Set several in one call.",
      kind: "write",
      group: "crossfilter",
    },
    {
      name: "reset-cross-filters",
      description: "Remove every cross-filter clause.",
      kind: "write",
      group: "crossfilter",
    },
    {
      name: "sql",
      description: "Run one read-only SQL statement against the catalog.",
      usage:
        "Tables: `quakes`. Views: `crossfilter.quakes`, `complete.quakes`. Aggregate in SQL rather than fetching rows.",
      kind: "read",
      group: "sql",
    },
    { name: "schema", description: "Tables and columns with types.", kind: "read", group: "sql" },
    {
      name: "suggest-mc",
      description: "The data-driven completeness magnitude.",
      kind: "read",
      group: "app",
    },
    {
      name: "save-view",
      description: "Save the current dimension state under a name.",
      kind: "write",
      group: "views",
    },
    { name: "legacy", description: "A tool without a class." },
  ],
};

describe("corpus: the tool brief", () => {
  it("a seismos-shaped surface, and the same under a character budget", async () => {
    await expect(renderToolBrief([seismosLike])).toMatchFileSnapshot(
      corpus("tool-brief-seismos-like.txt"),
    );
    await expect(renderToolBrief([seismosLike], { maxChars: 900 })).toMatchFileSnapshot(
      corpus("tool-brief-seismos-like-900.txt"),
    );
  });

  it("the standard tools' own descriptions and usage", async () => {
    const tools = new Map<string, ToolDoc>();
    const kit = {
      ns: "corpus",
      registerTool: (tool: ToolDoc & { run?: unknown }) => {
        const { run: _run, ...doc } = tool;
        tools.set(tool.name, doc as ToolDoc);
      },
      registerReporter: () => {},
      handle: () => ({ reporters: {} }),
    } as unknown as AgentToolkit;
    registerStandardTools(kit);
    const docs = [...tools.values()].map(({ name, description, usage, kind, group }) => ({
      name,
      description,
      ...(usage !== undefined ? { usage } : {}),
      ...(kind !== undefined ? { kind } : {}),
      ...(group !== undefined ? { group } : {}),
    }));
    await expect(renderToolBrief([{ ns: "corpus", tools: docs }])).toMatchFileSnapshot(
      corpus("tool-brief-standard-tools.txt"),
    );
  });
});
