import { describe, expect, it } from "vitest";
import { fixtures } from "./fixtures";
import { measure, request, textPart } from "./model";
import { previewUnits } from "./preview";
import { changeKind, counterpart, coverage, hidden, initialState, key, reduce } from "./state";

const scientific = fixtures[2];

describe("fixture mappings and complete previews", () => {
  it("partitions every text part and covers it with a complete Markdown parse", () => {
    for (const fixture of fixtures)
      for (const side of ["before", "after"] as const) {
        const artifact = fixture[side];
        for (const part of artifact.parts) {
          if (part.kind !== "text") continue;
          let end = 0;
          for (const contribution of part.contributions) {
            expect(contribution.start).toBe(end);
            expect(artifact.occurrences.some((o) => o.id === contribution.owner)).toBe(true);
            end = contribution.end;
          }
          expect(end).toBe(part.text.length);
          const units = previewUnits(part);
          expect(units[0]?.start).toBe(0);
          expect(units.at(-1)?.end).toBe(part.text.length);
          expect(units.map((u) => u.html).join("")).not.toContain("katex-error");
        }
      }
  });

  it("maps an equation across command and brace boundaries without injecting TeX annotations", () => {
    const part = scientific.after.parts[0];
    expect(part.kind).toBe("text");
    if (part.kind !== "text") return;
    const math = previewUnits(part).find((unit) => unit.kind === "displayMath");
    expect(math?.owners).toEqual(["numerator", "denominator"]);
    expect(math?.html).toContain("katex");
    expect(math?.html).not.toContain("katex-error");
    expect(part.text.slice(math?.start, math?.end)).toBe("$$\n\\frac{a}{b}\n$$\n\n");
  });

  it("keeps repeated text, entities, CRLF, and astral Unicode in exact UTF-16 source ranges", () => {
    const part = textPart("unicode", [
      ["a", "A &amp; 😀\r\n"],
      ["b", "A &amp; 😀\r\n"],
    ]);
    expect(part.contributions).toEqual([
      { owner: "a", start: 0, end: 12 },
      { owner: "b", start: 12, end: 24 },
    ]);
    expect(part.text.slice(12, 24)).toBe("A &amp; 😀\r\n");
  });

  it("source line spans stay inside the displayed fixture revision", () => {
    for (const fixture of fixtures)
      for (const artifact of [fixture.before, fixture.after])
        for (const occurrence of artifact.occurrences) {
          const lines = artifact.sources[occurrence.source.file].split("\n");
          expect(occurrence.source.startLine).toBeGreaterThan(0);
          expect(occurrence.source.endLine).toBeLessThanOrEqual(lines.length);
        }
  });
});

describe("shared fold state", () => {
  it("reports a co-owned equation as partial, then fully covered", () => {
    let state = initialState(scientific);
    state = reduce(state, { type: "fold", side: "after", owner: "numerator" });
    expect(coverage(state, "after", ["numerator", "denominator"])).toBe("partial");
    state = reduce(state, { type: "fold", side: "after", owner: "denominator" });
    expect(coverage(state, "after", ["numerator", "denominator"])).toBe("full");
  });

  it("preserves nested fold intent and never changes the request or double-counts coverage", () => {
    let state = initialState(scientific);
    const original = JSON.stringify(request(state.fixture.after));
    state = reduce(state, { type: "fold", side: "after", owner: "numerator" });
    state = reduce(state, { type: "fold", side: "after", owner: "ratio" });
    const count = measure(scientific.after, (owner) => hidden(state, "after", owner));
    expect(count.hiddenText).toBe("$$\n\\frac{a}{b}\n$$\n\n".length);
    state = reduce(state, { type: "fold", side: "after", owner: "ratio" });
    expect(hidden(state, "after", "numerator")).toBe(true);
    expect(hidden(state, "after", "denominator")).toBe(false);
    expect(JSON.stringify(request(state.fixture.after))).toBe(original);
  });

  it("keeps reusable placements independent and outline disclosure separate from content", () => {
    let state = initialState(fixtures[1]);
    state = reduce(state, { type: "fold", side: "after", owner: "primary" });
    expect(hidden(state, "after", "primary-text")).toBe(true);
    expect(hidden(state, "after", "repeat-text")).toBe(false);
    state = reduce(state, { type: "outline", side: "after", owner: "check" });
    expect(hidden(state, "after", "repeat-text")).toBe(false);
  });

  it("reconciles fold keys when switching revisions and drops deleted selections", () => {
    let state = initialState(fixtures[1]);
    state = reduce(state, { type: "revision", revision: "before" });
    state = reduce(state, { type: "fold", side: "before", owner: "primary" });
    state = reduce(state, {
      type: "select",
      selection: { side: "before", owners: ["background"], from: "tree" },
    });
    state = reduce(state, { type: "revision", revision: "after" });
    expect(state.selection).toBeUndefined();
    expect(hidden(state, "after", "primary-text")).toBe(true);
    expect(state.folded.has(key("after", "background"))).toBe(false);
  });
});

describe("comparison and payload boundaries", () => {
  it("uses image content revision, not equal dimensions/caption, to identify a change", () => {
    expect(changeKind(scientific, "after", "plot")).toBe("changed");
    expect(changeKind(scientific, "after", "energy")).toBe("same");
  });

  it("only links folding where an explicit occurrence counterpart exists", () => {
    let state = reduce(initialState(fixtures[1]), { type: "compare" });
    state = reduce(state, { type: "fold", side: "before", owner: "background" });
    expect(counterpart(state, "before", "background")).toBeUndefined();
    expect(changeKind(fixtures[1], "before", "background")).toBe("removed");
    expect(state.folded.has(key("after", "background"))).toBe(false);
    state = reduce(state, { type: "fold", side: "before", owner: "primary" });
    expect(state.folded.has(key("after", "primary"))).toBe(true);
  });

  it("keeps text-image-text order and history outside the newly authored turn", () => {
    const payload = request(scientific.after);
    expect(payload.currentTurn.messages[0].content.map((part) => part.type)).toEqual([
      "text",
      "image",
      "text",
    ]);
    expect(payload.history).toEqual({ kind: "conversation", id: "thread-fixture-42" });
    expect(payload.currentTurn).not.toHaveProperty("history");
    expect(JSON.stringify(payload)).not.toContain("data:image");
  });
});
