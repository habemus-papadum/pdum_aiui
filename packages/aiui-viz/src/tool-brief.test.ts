import { projectTools, rehydrate } from "@habemus-papadum/aiui-prompts";
import { describe, expect, it } from "vitest";
import {
  instructionsWithToolBrief,
  type KitDoc,
  renderPrompt,
  renderToolBrief,
  type ToolDoc,
  toolBrief,
  toolFingerprint,
  toolSnapshot,
} from "./tool-brief";

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

  it("is the toolkit's brief projection of the same snapshot, byte for byte", () => {
    const snapshot = toolSnapshot([seismos]);
    const projected = (options: { maxChars?: number; qualify?: boolean }) =>
      projectTools(snapshot, { style: "brief", ...options })
        .segments.map((s) => s.text)
        .join("");
    expect(renderToolBrief(snapshot)).toBe(projected({}));
    expect(renderToolBrief(snapshot, { maxChars: 120 })).toBe(projected({ maxChars: 120 }));
    expect(renderToolBrief(snapshot, { qualify: true })).toBe(projected({ qualify: true }));
  });
});

describe("renderToolBrief — groups", () => {
  it("gathers a section's tools under their group sub-headings, ungrouped first", () => {
    const text = renderToolBrief([
      {
        ns: "app",
        tools: [
          { name: "sql", description: "Run SQL.", kind: "read", group: "sql" },
          { name: "report", description: "Snapshot.", kind: "read", group: "app" },
          { name: "peek", description: "Custom read.", kind: "read" },
          { name: "schema", description: "Describe.", kind: "read", group: "sql" },
          { name: "cross-filter", description: "Filter.", kind: "write", group: "crossfilter" },
        ],
      },
    ]);
    expect(text).toBe(
      [
        "Tools:",
        "Read tools (call freely once the intent is clear; no confirmation needed):",
        "- peek: Custom read.",
        "sql:",
        "- sql: Run SQL.",
        "- schema: Describe.",
        "app:",
        "- report: Snapshot.",
        "Write tools (they change the app; the result is the value actually applied):",
        "crossfilter:",
        "- cross-filter: Filter.",
        "If a tool fails, say what failed in a few words and do not repeat the same call unchanged.",
      ].join("\n"),
    );
  });
});

describe("toolSnapshot", () => {
  const kits = [
    {
      ns: "app",
      brief: "A lab.",
      tools: [
        { name: "report", description: "Read the state.", kind: "read" as const, group: "app" },
        {
          name: "set",
          description: "Write a value.",
          usage: "Trust the result.",
          kind: "write" as const,
        },
      ],
    },
  ];

  it("fingerprints the document stably, and moves when any declared field moves", () => {
    const a = toolFingerprint(kits);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(toolFingerprint(structuredClone(kits))).toBe(a);
    const usage = structuredClone(kits);
    (usage[0] as { tools: { usage?: string }[] }).tools[1].usage = "Trust nothing.";
    expect(toolFingerprint(usage)).not.toBe(a);
    const group = structuredClone(kits);
    (group[0] as { tools: { group?: string }[] }).tools[0].group = "page";
    expect(toolFingerprint(group)).not.toBe(a);
    const brief = structuredClone(kits);
    (brief[0] as { brief?: string }).brief = "Another lab.";
    expect(toolFingerprint(brief)).not.toBe(a);
  });

  it("renders the same text from a snapshot as from its kits, and carries the origin", () => {
    const snapshot = toolSnapshot(kits, { site: "page registry: app" });
    expect(snapshot.origin).toEqual({ site: "page registry: app" });
    expect(snapshot.fingerprint).toBe(toolFingerprint(kits));
    expect(toolSnapshot(kits, { site: "another registry" }).fingerprint).toBe(snapshot.fingerprint);
    expect(snapshot.kind).toBe("aiui.tools");
    expect(renderToolBrief(snapshot)).toBe(renderToolBrief(kits));
    expect(renderToolBrief(snapshot, { maxChars: 10 })).toBe(
      renderToolBrief(kits, { maxChars: 10 }),
    );
  });

  it("keeps the declared fields of a richer tool object and drops the rest (an executor never reaches the record)", () => {
    const live = {
      name: "sql",
      description: "Run SQL.",
      usage: undefined,
      kind: "read" as const,
      parameters: { type: "object" },
      execute: () => "rows",
    };
    const snapshot = toolSnapshot([{ ns: "app", brief: undefined, tools: [live as ToolDoc] }]);
    expect(snapshot.kits).toEqual([
      { ns: "app", tools: [{ name: "sql", description: "Run SQL.", kind: "read" }] },
    ]);
    const withSchema = toolSnapshot([
      { ns: "app", tools: [{ ...live, inputSchema: { type: "object" } } as ToolDoc] },
    ]);
    expect(withSchema.kits[0].tools[0].inputSchema).toEqual({ type: "object" });
    expect(withSchema.fingerprint).not.toBe(snapshot.fingerprint);
  });
});

describe("toolBrief, renderPrompt, instructionsWithToolBrief", () => {
  it("the node compiles to the rendered text, and its record rehydrates to the same parts", () => {
    const budget = renderToolBrief([seismos]).length - 1; // one usage line must go
    const rendered = renderPrompt(toolBrief([seismos], { maxChars: budget }));
    expect(rendered.text).toBe(renderToolBrief([seismos], { maxChars: budget }));
    expect(rendered.compiled.parts).toEqual([{ id: "p0", type: "text", text: rendered.text }]);
    expect(rehydrate(rendered.record).parts).toEqual(rendered.compiled.parts);
    // The budget is a recorded decision, not a lost branch.
    const decision = rendered.compiled.decisions.find((d) => d.kind === "tool-budget");
    expect(decision?.selected).toBe("elided-usage");
    expect(decision?.detail?.omittedUsage).toEqual(["seismos/set-mag"]);
    // And the record is plain JSON a ledger can hold.
    expect(JSON.parse(JSON.stringify(rendered.record))).toEqual(rendered.record);
  });

  it("instructions = preface, blank line, brief — and either half may be absent", () => {
    const brief = renderToolBrief([seismos]);
    expect(renderPrompt(instructionsWithToolBrief("You are the lab.", [seismos])).text).toBe(
      `You are the lab.\n\n${brief}`,
    );
    expect(renderPrompt(instructionsWithToolBrief("You are the lab.", [])).text).toBe(
      "You are the lab.",
    );
    expect(renderPrompt(instructionsWithToolBrief("", [seismos])).text).toBe(brief);
    expect(renderPrompt(instructionsWithToolBrief("You are the lab.", undefined)).text).toBe(
      "You are the lab.",
    );
    expect(renderPrompt(instructionsWithToolBrief(null, undefined)).text).toBe("");
  });

  it("the preface and the brief are separate contributions of the one text part", () => {
    const rendered = renderPrompt(instructionsWithToolBrief("Persona.", [seismos]));
    const owners = new Set(rendered.compiled.contributions.map((c) => c.occurrence));
    expect(owners.size).toBeGreaterThanOrEqual(3); // the text, the prompt's separator, the brief
    const brief = rendered.compiled.contributions.filter(
      (c) => c.origin !== undefined && c.origin.kind === "tool-projection",
    );
    expect(brief.length).toBeGreaterThan(0);
    for (const c of brief) {
      expect(c.origin?.snapshot).toBe(toolFingerprint([seismos]));
    }
  });
});
