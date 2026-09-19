import { describe, expect, it } from "vitest";
import { type KitDoc, renderToolBrief } from "./tool-brief";

const seismos: KitDoc = {
  ns: "seismos",
  brief: "An earthquake catalog (table `quakes`) with a live Gutenberg–Richter fit.",
  tools: [
    {
      name: "report",
      description: "One bounded snapshot of the whole app.",
      usage: "Call it first.",
      kind: "read",
    },
    {
      name: "set-mag",
      description: 'Set the "mag" cross-filter.',
      usage: "Trust { applied } over the request.",
      kind: "write",
    },
    { name: "suggest-mc", description: "Return the completeness magnitude." },
  ],
};

describe("renderToolBrief", () => {
  it("renders the brief, then tools grouped by kind, with fixed headings", () => {
    expect(renderToolBrief([seismos])).toBe(
      [
        "Tools:",
        "An earthquake catalog (table `quakes`) with a live Gutenberg–Richter fit.",
        "Read tools (call freely once the intent is clear; no confirmation needed):",
        "- report: One bounded snapshot of the whole app. Call it first.",
        "Write tools (they change the app; the result is the value actually applied):",
        '- set-mag: Set the "mag" cross-filter. Trust { applied } over the request.',
        "Other tools:",
        "- suggest-mc: Return the completeness magnitude.",
        "If a tool fails, say what failed in a few words and do not repeat the same call unchanged.",
      ].join("\n"),
    );
  });

  it("is empty with nothing to say, and deterministic", () => {
    expect(renderToolBrief([])).toBe("");
    expect(renderToolBrief([{ ns: "x", tools: [] }])).toBe("");
    expect(renderToolBrief([seismos])).toBe(renderToolBrief([seismos]));
  });

  it("qualifies names by namespace on request (a merged multi-kit array)", () => {
    const text = renderToolBrief(
      [seismos, { ns: "gears", tools: [{ name: "reset", description: "r" }] }],
      {
        qualify: true,
      },
    );
    expect(text).toContain("- seismos/report:");
    expect(text).toContain("- gears/reset: r");
  });

  it("drops usage (longest first) to meet a budget, never names or descriptions", () => {
    const full = renderToolBrief([seismos]);
    const tight = renderToolBrief([seismos], { maxChars: full.length - 1 });
    expect(tight.length).toBeLessThan(full.length);
    expect(tight).not.toContain("Trust { applied } over the request."); // the longest usage
    expect(tight).toContain("- report: One bounded snapshot of the whole app. Call it first.");
    expect(tight).toContain('- set-mag: Set the "mag" cross-filter.');
    // Every tool is still named — the list always matches the array.
    for (const t of seismos.tools) expect(tight).toContain(`- ${t.name}:`);
  });
});
