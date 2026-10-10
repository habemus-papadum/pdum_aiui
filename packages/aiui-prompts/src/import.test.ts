import { describe, expect, it } from "vitest";
import { mappingIndex } from "./analysis.ts";
import { rehydrate } from "./compile.ts";
import { importText } from "./import.ts";
import { parseRecord, serializeRecord, snapshot } from "./record.ts";

describe("opaque text with captured span lineage", () => {
  it("retains exact text, uncovered prose, and event/asset metadata without importing a renderer", () => {
    const text = 'Explain 🧪\r\n[shot x]\n<metadata source="sample.tsx"/>\nthen continue';
    const start = text.indexOf("[shot");
    const end = text.indexOf("\nthen");
    const record = snapshot(
      importText({
        text,
        origin: { kind: "captured-event", id: "turn-7" },
        spans: [
          {
            start,
            end,
            label: "Captured shot",
            origin: { event: "capture-9", asset: "shot:x", source: "sample.tsx" },
          },
        ],
      }),
    );
    const compiled = rehydrate(parseRecord(serializeRecord(record)));
    expect(compiled.parts).toEqual([{ id: "p0", type: "text", text }]);
    expect(compiled.contributions.map(({ start, end }) => [start, end])).toEqual([
      [0, start],
      [start, end],
      [end, text.length],
    ]);
    const explanation = mappingIndex(compiled).explain("p0", start, end)[0];
    expect(explanation.owners[0].label).toBe("Captured shot");
    expect(explanation.owners[0].origin).toMatchObject({
      kind: "imported-text",
      precision: "owner",
      span: { start, end },
      input: { event: "capture-9", asset: "shot:x" },
    });
    expect(explanation.owners.at(-1)?.origin).toEqual({ kind: "captured-event", id: "turn-7" });
  });
  it("rejects overlapping/out-of-bounds spans and surrogate splits instead of inventing ownership", () => {
    const origin = { event: "capture" };
    for (const spans of [
      [
        { start: 0, end: 2, origin },
        { start: 1, end: 3, origin },
      ],
      [{ start: 0, end: 20, origin }],
      [{ start: 0, end: 1, origin }],
      [{ start: 2, end: 2, origin }],
    ])
      expect(() => importText({ text: "🧪 text", origin, spans })).toThrow();
    expect(rehydrate(snapshot(importText({ text: "", origin }))).parts).toEqual([]);
  });
});
