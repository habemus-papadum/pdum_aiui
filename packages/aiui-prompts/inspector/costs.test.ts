import { describe, expect, it } from "vitest";
import { measurePrompt } from "../src/analysis.ts";
import {
  Elide,
  Image,
  Prompt,
  rehydrate,
  Section,
  snapshot,
  Text,
  Use,
  Xml,
} from "../src/index.ts";
import { occurrenceCosts } from "./costs.ts";

describe("occurrence contribution costs", () => {
  it("counts generated syntax, reused placements, multimodal parts, and retained elision output", () => {
    const shared = Section({
      title: "Shared",
      children: Text({ value: "🧪α", label: "Shared leaf" }),
    });
    const record = snapshot(
      Prompt({
        label: "Root",
        children: [
          Use({ value: shared, key: "one", label: "First use" }),
          Use({ value: shared, key: "two", label: "Second use" }),
          Image({ asset: { id: "image:test" }, label: "Image" }),
          Elide({
            unit: "characters",
            limit: 2,
            marker: "…",
            label: "Elision",
            children: Text({ value: "🧪αβγ", label: "Elided leaf" }),
          }),
        ],
      }),
    );
    const compiled = rehydrate(record);
    const before = JSON.stringify({ record, compiled });
    const costs = occurrenceCosts(compiled);
    const named = (label: string) => compiled.occurrences.find((item) => item.label === label);
    const namedCost = (label: string) => costs.get(named(label)?.id ?? "");

    expect(named("First use")?.definition).toBe(named("Second use")?.definition);
    expect(namedCost("First use")).toEqual({
      own: { codeUnits: 10, images: 0 },
      subtree: { codeUnits: 13, images: 0 },
    });
    expect(namedCost("Second use")).toEqual(namedCost("First use"));
    expect(namedCost("Shared leaf")?.own).toEqual({ codeUnits: 3, images: 0 });
    expect(namedCost("Image")).toEqual({
      own: { codeUnits: 0, images: 1 },
      subtree: { codeUnits: 0, images: 1 },
    });
    expect(namedCost("Elided leaf")?.own).toEqual({ codeUnits: 3, images: 0 });
    expect(namedCost("Elision")).toEqual({
      own: { codeUnits: 1, images: 0 },
      subtree: { codeUnits: 4, images: 0 },
    });
    // Root owns only three paragraph separators; every emitted interval is counted once.
    expect(namedCost("Root")).toEqual({
      own: { codeUnits: 6, images: 0 },
      subtree: { codeUnits: 36, images: 1 },
    });
    expect([...costs.values()].reduce((sum, cost) => sum + cost.own.codeUnits, 0)).toBe(36);
    expect(measurePrompt(compiled).codeUnits).toBe(36);
    expect(JSON.stringify({ record, compiled })).toBe(before);
  });

  it("measures emitted escaping and image placements rather than original text or unique assets", () => {
    const image = Image({ asset: { id: "same-asset" } });
    const compiled = rehydrate(
      snapshot(
        Prompt({
          children: [
            Use({ value: image, key: "first" }),
            Use({ value: image, key: "second" }),
            Xml({ tag: "data", children: Text({ value: "&🧪<", label: "Encoded text" }) }),
          ],
        }),
      ),
    );
    const costs = occurrenceCosts(compiled);
    const root = compiled.occurrences[0];
    const encoded = compiled.occurrences.find((item) => item.label === "Encoded text");
    expect(costs.get(encoded?.id ?? "")?.own.codeUnits).toBe("&amp;🧪&lt;".length);
    expect(costs.get(root.id)?.subtree.images).toBe(2);
    expect([...costs.values()].reduce((sum, cost) => sum + cost.own.images, 0)).toBe(2);
    const imageOccurrences = compiled.occurrences.filter((item) => item.kind === "image");
    expect(imageOccurrences.length).toBe(2);
    for (const item of imageOccurrences) expect(costs.get(item.id)?.subtree.images).toBe(1);
  });

  it("aggregates an unordered hierarchy without requiring recursive descendant scans", () => {
    const compiled = rehydrate(
      snapshot(
        Prompt({
          children: Section({
            title: "Outer",
            children: Section({ title: "Inner", children: "Nested content" }),
          }),
        }),
      ),
    );
    const measured = measurePrompt(compiled);
    expect(
      occurrenceCosts({ ...compiled, occurrences: [...compiled.occurrences].reverse() }, measured),
    ).toEqual(occurrenceCosts(compiled, measured));
  });
});
