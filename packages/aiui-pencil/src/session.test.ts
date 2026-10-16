import { describe, expect, it } from "vitest";
import { createInkDocument } from "./document";
import { clientToInk } from "./geometry";
import { WRITE } from "./pencil";
import { createInkSession } from "./session";
import type { PenSample } from "./telemetry";

const sample: PenSample = {
  x: 10,
  y: 20,
  t: 1,
  pressure: 0.5,
  altitude: Math.PI / 2,
  azimuth: 0,
  twist: 0,
  kind: "pen",
  width: 3,
  height: 4,
};

describe("InkSession", () => {
  it("namespaces contact IDs, permits reuse after completion, and cancels only owned drafts", () => {
    const document = createInkDocument();
    const first = createInkSession(document, { namespace: "first" });
    const second = createInkSession(document, { namespace: "second" });
    const committed = first.begin("pen", sample);
    first.finish("pen");
    const abandoned = first.begin("pen", sample);
    const other = second.begin("pen", sample);
    expect(abandoned).not.toBe(committed);
    first.dispose();
    first.dispose();
    expect(document.snapshot().strokes.map((stroke) => stroke.id)).toEqual([committed]);
    expect(document.snapshot().live.map((draft) => draft.id)).toEqual([other]);
    expect(() => first.begin("pen", sample)).toThrow("disposed");
    second.finish("pen");
    expect(document.snapshot().strokes).toHaveLength(2);
  });

  it("reads tool/profile at begin and maps every sample without scaling contact telemetry", () => {
    const document = createInkDocument();
    let params = WRITE;
    const viewport = { x: 2, y: 4, scale: 2 };
    const input = createInkSession(document, {
      params: () => params,
      map: (point) => clientToInk(point, viewport),
    });
    input.begin("pen", sample);
    params = { ...WRITE, size: 99 };
    input.append("pen", [{ ...sample, x: 22, y: 44 }]);
    input.finish("pen", { ...sample, x: 42, y: 64 });
    const stroke = document.snapshot().strokes[0];
    expect(stroke.points.map(({ x, y }) => [x, y])).toEqual([
      [4, 8],
      [10, 20],
      [20, 30],
    ]);
    expect(stroke.points.every((point) => point.width === 3 && point.height === 4)).toBe(true);
    expect(stroke.params.size).toBe(WRITE.size);
  });

  it("ignores delayed append/finish after a contact is cancelled", () => {
    const document = createInkDocument();
    const input = createInkSession(document);
    input.begin("pen", sample);
    input.cancel("pen");
    const snapshot = document.snapshot();
    input.append("pen", [sample]);
    input.finish("pen", sample);
    expect(document.snapshot()).toBe(snapshot);
    expect(document.canUndo).toBe(false);
  });
  it("retains input ownership when a document observer fails after a mutation", () => {
    const document = createInkDocument();
    const input = createInkSession(document);
    document.subscribe(() => {
      throw new Error("Observer failed");
    });
    expect(() => input.begin("one", sample)).toThrow("subscribers failed");
    expect(() => input.begin("two", sample)).toThrow("subscribers failed");
    expect(document.snapshot().live).toHaveLength(2);
    expect(() => input.dispose()).toThrow("during disposal");
    expect(document.snapshot().live).toHaveLength(0);
    expect(document.canUndo).toBe(false);
  });
});
