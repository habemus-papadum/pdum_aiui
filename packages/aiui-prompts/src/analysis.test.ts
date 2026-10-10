import { describe, expect, it } from "vitest";
import {
  comparePrompts,
  mappingIndex,
  measurePrompt,
  optimizePrompt,
  textEdit,
} from "./analysis.ts";
import { rehydrate } from "./compile.ts";
import { Choice, Group, Image, Section, Text, Use } from "./model.ts";
import { snapshot } from "./record.ts";

describe("mapped analysis and comparison", () => {
  it("partitions exact text costs and preserves separate image costs", () => {
    const compiled = rehydrate(
      snapshot(Section({ title: "Energy", children: ["😀", Image({ asset: { id: "plot" } })] })),
    );
    const measured = measurePrompt(compiled);
    expect(measured.images).toBe(1);
    expect(measured.codeUnits - measured.codePoints).toBe(1);
    expect(Object.values(measured.exclusive).reduce((n, x) => n + x.codeUnits, 0)).toBe(
      measured.codeUnits,
    );
    expect(Object.values(measured.exclusive).reduce((n, x) => n + x.images, 0)).toBe(1);
    // Tokens are always an estimate now, under the built-in conservative
    // estimator unless a host supplies its own; the identity says which.
    expect(measured.tokens).toEqual({
      certainty: "estimated",
      value: expect.any(Number),
      estimator: { name: "aiui-prompts/conservative", version: "1" },
    });
    expect(measured.tokens.value).toBeGreaterThan(0);
    const image = compiled.parts.find((part) => part.type === "image");
    if (!image) throw new Error("Expected an image part");
    expect(mappingIndex(compiled).explain(image.id)).toHaveLength(1);
    expect(() => mappingIndex(compiled).explain(image.id, 0, 0)).toThrow(/atomic/);
  });
  it("queries emitted offsets and separates construction from placement source", () => {
    const definition = Text({ value: "abcdef", origin: { file: "definition.tsx" } });
    const compiled = rehydrate(
      snapshot(Use({ value: definition, origin: { file: "placement.tsx" } })),
    );
    const index = mappingIndex(compiled);
    const match = index.explain(compiled.parts[0].id, 2, 5)[0];
    expect(match.sourcePrecision).toBe("owner");
    expect(match.owners[0].origin).toEqual({ file: "placement.tsx" });
    expect(match.owners[0].definitionOrigin).toEqual({ file: "definition.tsx" });
    expect(index.forOccurrence("o")).toEqual(compiled.contributions);
    expect(index.explain(compiled.parts[0].id, 3, 3)).toEqual([]);
    expect(() => index.explain(compiled.parts[0].id, -1, 8)).toThrow(/range/);
    expect(() => index.explain("missing")).toThrow(/Unknown part/);
  });
  it("does not split surrogate pairs at changed text boundaries", () => {
    expect(textEdit("a😀z", "a😃z")).toEqual({
      before: { start: 1, end: 3 },
      after: { start: 1, end: 3 },
    });
    expect(textEdit("a😀z", "a😀z")).toBeNull();
  });
  it("does not mistake a matching image ID for verified unchanged bytes", () => {
    const before = snapshot(Image({ asset: { id: "plot", uri: "https://example.test/plot" } }));
    expect(comparePrompts(before, before).changes[0].kind).toBe("unknown-content");
    const fixed = snapshot(Image({ asset: { id: "plot", digest: "sha256:abc" } }));
    expect(comparePrompts(fixed, fixed).changes[0].kind).toBe("same-content");
  });
  it("matches explicit scoped keys without claiming that unkeyed movement is known", () => {
    const a = snapshot(Use({ key: "before", value: "text" }));
    const b = snapshot(Use({ key: "after", value: "text" }));
    expect(comparePrompts(a, b).matches).toEqual([]);
    expect(comparePrompts(a, a).matches).toEqual([
      { before: "o", after: "o", reason: "scoped-key" },
    ]);
    expect(comparePrompts(snapshot("text"), snapshot("text")).matches).toEqual([]);
  });
});

describe("bounded authored-variant search", () => {
  const record = () =>
    snapshot(
      Group({
        children: [
          "required",
          Choice({ name: "details", children: "long details", short: "brief" }),
        ],
      }),
    );
  it("returns a new replayable record and separately verifies the selected candidate", () => {
    const original = record();
    let calls = 0;
    const result = optimizePrompt(original, {
      budget: 13,
      measure: (compiled) => {
        calls++;
        return {
          value: measurePrompt(compiled).codeUnits,
          certainty: "exact",
          unit: "utf16-code-units",
          scope: "current-content",
          method: "test/1",
        };
      },
    });
    expect(result.status).toBe("fit");
    expect(result.candidates).toHaveLength(2);
    expect(calls).toBe(3);
    expect(result.result?.record.fingerprint).not.toBe(original.fingerprint);
    expect(rehydrate(original).parts).not.toEqual(result.result?.compiled.parts);
    if (!result.result) throw new Error("Expected a fitting candidate");
    expect(rehydrate(result.result.record)).toEqual(result.result.compiled);
    expect(result.candidates[1].verification?.value).toBeLessThanOrEqual(13);
  });
  it("distinguishes a bounded search from proven infeasibility in its declared candidate space", () => {
    expect(optimizePrompt(record(), { budget: 0, maxCandidates: 1 }).status).toBe(
      "search-exhausted",
    );
    expect(optimizePrompt(record(), { budget: 0 }).status).toBe("infeasible");
  });
  it("only enumerates short variants when authored, and rejects misspelled selectors", () => {
    const value = snapshot(Choice({ name: "optional", children: "long" }));
    const result = optimizePrompt(value, { budget: 0 });
    expect(result.status).toBe("fit");
    expect(result.candidates).toHaveLength(2);
    expect(() => optimizePrompt(value, { budget: 0, choices: { typo: ["omit"] } })).toThrow(
      /declared choice/,
    );
    expect(() => optimizePrompt(value, { budget: 0, choices: { optional: ["short"] } })).toThrow(
      /available variants/,
    );
  });
  it("reports unavailable cost and propagates broken estimator contracts instead of infeasibility", () => {
    const measure = () => ({
      value: null,
      certainty: "unknown" as const,
      unit: "tokens",
      scope: "request",
      method: "no-remote-history/1",
    });
    expect(
      optimizePrompt(record(), { budget: 5, unit: "tokens", scope: "request", measure }).status,
    ).toBe("unknown-cost");
    expect(() => optimizePrompt(record(), { budget: 5, measure })).toThrow(
      /incompatible measurement/,
    );
    expect(() =>
      optimizePrompt(record(), {
        budget: 5,
        measure: () => {
          throw new Error("offline");
        },
      }),
    ).toThrow(/Estimator failed: offline/);
  });
  it("records failed verification once and refuses to claim a fit", () => {
    let calls = 0;
    const result = optimizePrompt(record(), {
      budget: 5,
      maxCandidates: 1,
      measure: () => ({
        value: ++calls === 1 ? 1 : 100,
        certainty: "estimated",
        unit: "utf16-code-units",
        scope: "current-content",
        method: "unstable/1",
      }),
    });
    expect(result.status).toBe("unknown-cost");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].verification?.value).toBe(100);
  });
});
