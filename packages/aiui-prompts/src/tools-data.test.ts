import { describe, expect, it } from "vitest";
import {
  projectToolSchemas,
  projectTools,
  toolSnapshot,
  validateToolSnapshot,
} from "./tools-data.ts";

const declarations = () => [
  {
    ns: "app",
    brief: "Inspect a scientific run. More detail.",
    tools: [
      {
        name: "read",
        description: "Read state. Keep the units.",
        kind: "read" as const,
        usage: "Use for inspection.",
        inputSchema: { type: "object" },
      },
      {
        name: "update",
        description: "Update state.",
        kind: "write" as const,
        usage: "A considerably longer usage example for modifying a single field.",
        inputSchema: { type: "object" },
      },
    ],
  },
];
const text = (result: ReturnType<typeof projectTools>) =>
  result.segments.map((segment) => segment.text).join("");

describe("retained tool declarations and projections", () => {
  it("captures owned immutable declarations and validates readback", () => {
    const kits = declarations();
    const snapshot = toolSnapshot(kits, { site: "tool-registration" });
    kits[0].tools[0].description = "mutated";
    expect(snapshot.kits[0].tools[0].description).toBe("Read state. Keep the units.");
    expect(Object.isFrozen(snapshot.kits[0])).toBe(true);
    expect(() => validateToolSnapshot(JSON.parse(JSON.stringify(snapshot)))).not.toThrow();
    expect(() =>
      validateToolSnapshot({ ...snapshot, schemaVersion: 2 } as unknown as typeof snapshot),
    ).toThrow(/schema/);
    expect(() => validateToolSnapshot({ ...snapshot, origin: {} })).toThrow(/fingerprint/);
  });
  it("derives brief, capabilities, JSON, and provider schemas from the same source", () => {
    const snapshot = toolSnapshot(declarations());
    const brief = projectTools(snapshot, { style: "brief" });
    const capabilities = projectTools(snapshot, { style: "capabilities" });
    const schema = projectToolSchemas(snapshot);
    expect(text(brief)).toContain("Read state. Keep the units. Use for inspection.");
    expect(text(capabilities)).toBe(
      "- App: Inspect a scientific run.\n- read: Read state.\n- update: Update state.",
    );
    expect(JSON.parse(text(projectTools(snapshot, { style: "json" })))).toEqual(snapshot.kits);
    expect(schema[0].tool).toEqual({
      type: "function",
      name: "read",
      description: "Read state. Keep the units.",
      parameters: { type: "object" },
      strict: false,
    });
    expect(schema[0].origin.snapshot).toBe(snapshot.fingerprint);
    expect(
      brief.segments
        .filter((s) => s.origin)
        .every((s) => s.origin?.snapshot === snapshot.fingerprint),
    ).toBe(true);
  });
  it("drops longest usage first, retaining mandatory names/descriptions and an auditable cap decision", () => {
    const snapshot = toolSnapshot(declarations());
    const full = text(projectTools(snapshot, { style: "brief" }));
    const result = projectTools(snapshot, { style: "brief", maxChars: full.length - 1 });
    expect(result.decisions[0].detail.omittedUsage).toEqual(["app/update"]);
    expect(text(result)).toContain("Use for inspection.");
    expect(text(result)).not.toContain("considerably longer");
    const impossible = projectTools(snapshot, { style: "brief", maxChars: 1 });
    expect(impossible.decisions[0].selected).toBe("required-over-budget");
    expect(text(impossible)).toContain("- update: Update state.");
    expect(text(impossible)).toContain("If a tool fails");
    expect(impossible.decisions[0].detail.after).toBe(text(impossible).length);
  });
  it("attributes declared fields separately from generated framing without changing the text", () => {
    const snapshot = toolSnapshot(declarations());
    const brief = projectTools(snapshot, { style: "brief", qualify: true });
    const index = brief.segments.findIndex((segment) => segment.origin?.field === "app/read/name");
    expect(brief.segments.slice(index - 3, index + 5)).toEqual([
      { text: "- ", relation: "generated" },
      { text: "app", relation: "authored", origin: expect.objectContaining({ field: "app/ns" }) },
      { text: "/", relation: "generated" },
      {
        text: "read",
        relation: "authored",
        origin: expect.objectContaining({ field: "app/read/name" }),
      },
      { text: ": ", relation: "generated" },
      {
        text: "Read state. Keep the units.",
        relation: "authored",
        origin: expect.objectContaining({ field: "app/read/description" }),
      },
      { text: " ", relation: "generated" },
      {
        text: "Use for inspection.",
        relation: "authored",
        origin: expect.objectContaining({ field: "app/read/usage" }),
      },
    ]);
    const shortened = projectTools(snapshot, { style: "brief", maxChars: 1 });
    expect(
      shortened.segments.some(
        (segment) =>
          typeof segment.origin?.field === "string" && segment.origin.field.endsWith("/usage"),
      ),
    ).toBe(false);
    const capabilities = projectTools(snapshot, { style: "capabilities" });
    expect(
      capabilities.segments.find((segment) => segment.origin?.field === "app/read/description")
        ?.text,
    ).toBe("Read state.");
  });
  it("rejects ambiguous projection names and invalid vendor schemas", () => {
    const kits = declarations();
    const duplicated = toolSnapshot([...kits, { ...kits[0], ns: "second" }]);
    expect(() => projectTools(duplicated, { style: "brief" })).toThrow(/ambiguous/);
    expect(text(projectTools(duplicated, { style: "brief", qualify: true }))).toContain(
      "second/read",
    );
    expect(projectToolSchemas(duplicated, true).map((x) => x.tool.name)).toContain("second_read");
    expect(() =>
      projectToolSchemas(
        toolSnapshot([{ ns: "app", tools: [{ name: "x", description: "No schema." }] }]),
      ),
    ).toThrow(/no input schema/);
    expect(() =>
      projectTools(duplicated, { style: "capabilities", maxChars: 10, qualify: true }),
    ).toThrow(/explicit Elide/);
  });
  it("rejects execution callbacks and duplicate identities at the record boundary", () => {
    expect(() =>
      toolSnapshot([
        { ns: "a", tools: [{ name: "x", description: "x", execute: () => 1 }] },
      ] as never),
    ).toThrow();
    expect(() => toolSnapshot([...declarations(), ...declarations()])).toThrow(/unique/);
  });
});
