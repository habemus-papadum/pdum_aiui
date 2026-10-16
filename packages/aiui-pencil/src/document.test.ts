import { describe, expect, it } from "vitest";
import {
  createInkDocument,
  eraserCoverage,
  type InkChange,
  type InkDocument,
  previewStrokes,
} from "./document";
import { coverageContainsPoint } from "./geometry";
import { type PencilParams, WRITE } from "./pencil";
import type { PenSample } from "./telemetry";

function point(x: number, y = 0, t = x): PenSample {
  return {
    x,
    y,
    t,
    pressure: 1,
    altitude: Math.PI / 2,
    azimuth: 0,
    twist: 0,
    kind: "pen",
    width: 2,
    height: 2,
  };
}

const params: PencilParams = {
  ...WRITE,
  filter: { minCutoff: 1e6, beta: 0, dCutoff: 1e6 },
  size: 2,
  pressureToRadius: [1, 1],
  tiltToRadius: [1, 1],
  tiltToEccentricity: 0,
  grain: 0,
};

function draw(ink: InkDocument, id: string, y = 0): void {
  ink.begin(id, { tool: "draw", params, point: point(0, y) });
  ink.finish(id, point(100, y));
}

describe("InkDocument input and immutable records", () => {
  it("copies input settings and samples, publishes completion atomically, and uses an injected clock", () => {
    let now = 10;
    const ink = createInkDocument({ now: () => now });
    const events: InkChange[] = [];
    ink.subscribe((change) => events.push(change));
    const settings = structuredClone(params);
    const first = point(1);
    ink.begin("a", { tool: "draw", params: settings, point: first });
    first.x = 300;
    settings.filter.minCutoff = 0;
    (settings.pressureToRadius as number[])[0] = 10;
    const before = ink.snapshot();
    const more = point(5);
    ink.append("a", [more]);
    more.x = 500;
    now = 20;
    ink.finish("a", point(10));

    const snapshot = ink.snapshot();
    const stroke = snapshot.strokes[0];
    expect(stroke.points.map((sample) => sample.x)).toEqual([1, 5, 10]);
    expect(stroke.params.filter.minCutoff).toBe(1e6);
    expect(stroke.params.pressureToRadius[0]).toBe(1);
    expect(stroke.startedAt).toBe(10);
    expect(stroke.endedAt).toBe(20);
    expect(snapshot.live).toEqual([]);
    expect(before.live[0].points).toHaveLength(1);
    expect(events.map((change) => change.kind)).toEqual(["begin", "append", "finish"]);
    expect(events[2].snapshot.strokes).toEqual([stroke]);
    expect(events[2].snapshot.live).toEqual([]);
    expect(events[0].snapshot.live[0].points).toHaveLength(1);
    expect(events[1].snapshot.live[0].points).toHaveLength(2);
    expect(ink.snapshot()).toBe(snapshot);
    expect(() => {
      stroke.points[0].x = 900;
    }).toThrow();
    expect(() => {
      stroke.params.filter.beta = 99;
    }).toThrow();
  });

  it("keeps snapshots and unrelated completed records stable during other live input", () => {
    const ink = createInkDocument();
    draw(ink, "a");
    const original = ink.snapshot().strokes[0];
    ink.begin("b", { tool: "draw", params, point: point(2) });
    const opening = ink.snapshot();
    ink.append("b", [point(3), point(4)]);
    expect(ink.snapshot().strokes[0]).toBe(original);
    expect(opening.live[0].points).toHaveLength(1);
    ink.finish("b");
    expect(ink.snapshot().strokes[0]).toBe(original);
  });

  it("cancellation and invalid sample batches do not add history or partially change data", () => {
    const ink = createInkDocument();
    ink.begin("a", { tool: "draw", params, point: point(1) });
    const opening = ink.snapshot();
    expect(() => ink.append("a", [point(2), point(Number.NaN)])).toThrow("finite");
    expect(ink.snapshot()).toBe(opening);
    ink.cancel("a");
    expect(ink.snapshot().live).toEqual([]);
    expect(ink.snapshot().strokes).toEqual([]);
    expect(ink.canUndo).toBe(false);
    expect(ink.undo()).toBe(false);
  });

  it("rejects IDs that could collide when an earlier removal is undone", () => {
    const ink = createInkDocument();
    draw(ink, "a");
    ink.remove(["a"]);
    expect(() => ink.begin("a", { tool: "draw", params, point: point(0) })).toThrow("unique");
    ink.undo();
    expect(ink.snapshot().strokes.map((stroke) => stroke.id)).toEqual(["a"]);
  });

  it("keeps each event's snapshot coherent when a subscriber performs another operation", () => {
    const ink = createInkDocument();
    const events: InkChange[] = [];
    ink.subscribe((event) => {
      if (event.kind === "begin") ink.append("a", [point(2)]);
    });
    ink.subscribe((event) => events.push(event));
    ink.begin("a", { tool: "draw", params, point: point(1) });
    const beginning = events.find((event) => event.kind === "begin");
    const append = events.find((event) => event.kind === "append");
    expect(beginning?.snapshot.live[0].points).toHaveLength(1);
    expect(append?.snapshot.live[0].points).toHaveLength(2);
    expect(beginning?.revision).toBe(1);
    expect(append?.revision).toBe(2);
    expect(events.map((event) => event.revision)).toEqual([1, 2]);
  });

  it("delivers committed changes to remaining subscribers even if one observer fails", () => {
    const ink = createInkDocument();
    const events: InkChange[] = [];
    ink.subscribe(() => {
      throw new Error("Observer failed");
    });
    ink.subscribe((event) => events.push(event));
    expect(() => ink.begin("a", { tool: "draw", params, point: point(1) })).toThrow(
      "subscribers failed",
    );
    expect(events[0].snapshot.live[0].id).toBe("a");
    expect(() => ink.cancel("a")).toThrow("subscribers failed");
    expect(events[1].snapshot.live).toEqual([]);
  });
});

describe("InkDocument edits and history", () => {
  it("undoes and redoes partial erasure across multiple strokes as one transaction", () => {
    const ink = createInkDocument();
    draw(ink, "a");
    draw(ink, "b", 10);
    draw(ink, "untouched", 80);
    const before = ink.snapshot();
    const events: InkChange[] = [];
    ink.subscribe((event) => events.push(event));
    ink.begin("erase", { tool: "erase", params: { ...params, size: 3 }, point: point(50, -10) });
    ink.append("erase", [point(50, 20)]);
    const preview = previewStrokes(ink.snapshot());
    expect(preview[0].erasures).toHaveLength(1);
    expect(preview[1].erasures).toHaveLength(1);
    expect(preview[2]).toBe(before.strokes[2]);
    expect(ink.snapshot().strokes[0].erasures).toHaveLength(0);
    ink.finish("erase");

    const erased = ink.snapshot();
    expect(erased.strokes.map((stroke) => stroke.erasures.length)).toEqual([1, 1, 0]);
    expect(events.filter((event) => event.kind === "finish")).toHaveLength(1);
    expect(events.at(-1)?.ids).toEqual(["erase", "a", "b"]);
    expect(erased.strokes[2]).toBe(before.strokes[2]);
    expect(coverageContainsPoint(erased.strokes[0].erasures[0], { x: 52, y: 0 })).toBe(true);
    expect(erased.strokes[0].erasures[0].points).toHaveLength(2);

    ink.undo();
    const restored = ink.snapshot();
    expect(restored.strokes.map((stroke) => stroke.erasures.length)).toEqual([0, 0, 0]);
    expect(restored.strokes[0].id).toBe("a");
    expect(restored.strokes[0].revision).toBeGreaterThan(erased.strokes[0].revision);
    expect(restored.strokes[2]).toBe(before.strokes[2]);
    ink.redo();
    expect(ink.snapshot().strokes.map((stroke) => stroke.erasures.length)).toEqual([1, 1, 0]);
    expect(ink.snapshot().strokes[0].revision).toBeGreaterThan(restored.strokes[0].revision);
  });

  it("erases between sparse samples, and whole-stroke erasing ignores an already erased gap", () => {
    const ink = createInkDocument();
    draw(ink, "a");
    ink.begin("cut", { tool: "erase", params: { ...params, size: 10 }, point: point(50, -20) });
    ink.finish("cut", point(50, 20));
    ink.begin("inside-gap", {
      tool: "erase-stroke",
      params: { ...params, size: 1 },
      point: point(50),
    });
    ink.finish("inside-gap");
    expect(ink.snapshot().strokes).toHaveLength(1);
    ink.begin("remaining-ink", { tool: "erase-stroke", params, point: point(80) });
    ink.finish("remaining-ink");
    expect(ink.snapshot().strokes).toHaveLength(0);
    ink.undo();
    expect(ink.snapshot().strokes[0].id).toBe("a");
    expect(ink.snapshot().strokes[0].erasures).toHaveLength(1);
  });

  it("freezes eraser targets at begin, excluding later completed ink and live drafts", () => {
    const ink = createInkDocument();
    draw(ink, "a");
    ink.begin("erase", { tool: "erase", params, point: point(50) });
    draw(ink, "new");
    ink.begin("live", { tool: "draw", params, point: point(50) });
    ink.finish("erase");
    expect(ink.snapshot().strokes.map((stroke) => stroke.erasures.length)).toEqual([1, 0]);
    expect(ink.snapshot().live.map((draft) => draft.id)).toEqual(["live"]);
  });

  it("invalidates an eraser target if that record changes during the gesture", () => {
    const ink = createInkDocument();
    draw(ink, "a");
    ink.begin("erase", { tool: "erase", params, point: point(50) });
    ink.setParams(["a"], { ...params, color: "red" });
    expect(previewStrokes(ink.snapshot())[0].erasures).toHaveLength(0);
    ink.finish("erase");
    expect(ink.snapshot().strokes[0].erasures).toHaveLength(0);
  });

  it("cancels an eraser preview without adding an undo step", () => {
    const ink = createInkDocument();
    draw(ink, "a");
    const before = ink.snapshot().strokes;
    ink.begin("erase", { tool: "erase-stroke", params, point: point(50) });
    expect(previewStrokes(ink.snapshot())).toEqual([]);
    ink.cancel("erase");
    expect(ink.snapshot().strokes).toBe(before);
    ink.undo();
    expect(ink.snapshot().strokes).toEqual([]);
  });

  it("stores erasure in stroke-local coordinates and keeps it attached when ink moves", () => {
    const ink = createInkDocument();
    draw(ink, "a");
    const original = ink.snapshot().strokes[0];
    ink.setTransform(["a"], { x: 200, y: 10, scale: 2 });
    ink.begin("erase", { tool: "erase", params: { ...params, size: 10 }, point: point(300, 10) });
    ink.finish("erase");
    const cut = ink.snapshot().strokes[0];
    expect(cut.erasures[0].points).toEqual([{ x: 50, y: 0, radius: 5 }]);
    ink.setTransform(["a"], { x: 900, y: 800, scale: 3 });
    const moved = ink.snapshot().strokes[0];
    expect(moved.points).toBe(original.points);
    expect(moved.erasures).toBe(cut.erasures);
    expect(moved.endedAt).toBe(original.endedAt);
    expect(() => ink.setTransform(["a"], { x: 0, y: 0, scale: 0 })).toThrow("positive");
  });

  it("rotates placement without rewriting source ink and maps erasure back into stroke space", () => {
    const ink = createInkDocument();
    draw(ink, "rotated");
    const original = ink.snapshot().strokes[0];
    ink.setTransform(["rotated"], { x: 100, y: 50, scale: 2, rotation: Math.PI / 2 });
    ink.begin("cut", { tool: "erase", params: { ...params, size: 10 }, point: point(100, 150) });
    ink.finish("cut");
    const erased = ink.snapshot().strokes[0];
    expect(erased.points).toBe(original.points);
    expect(erased.erasures).toHaveLength(1);
    const disk = erased.erasures[0].points[0];
    expect(disk.x).toBeCloseTo(50, 10);
    expect(disk.y).toBeCloseTo(0, 10);
    expect(disk.radius).toBe(5);
    // A whole-stroke eraser entirely inside the previous cut must miss.
    ink.begin("miss", {
      tool: "erase-stroke",
      params: { ...params, size: 1 },
      point: point(100, 150),
    });
    ink.finish("miss");
    expect(ink.snapshot().strokes).toHaveLength(1);
    ink.setTransform(["rotated"], { x: 100, y: 50, scale: 2, rotation: -Math.PI / 2 });
    const moved = ink.snapshot().strokes[0];
    expect(moved.erasures).toBe(erased.erasures);
    expect(moved.points).toBe(original.points);
    expect(moved.transform.rotation).toBe(-Math.PI / 2);
    ink.undo();
    expect(ink.snapshot().strokes[0].transform.rotation).toBe(Math.PI / 2);
    expect(() =>
      ink.setTransform(["rotated"], { x: 0, y: 0, scale: 1, rotation: Number.NaN }),
    ).toThrow("rotation");
  });

  it("bounds history without discarding visible ink and clears redo only for committed changes", () => {
    const ink = createInkDocument({ historyLimit: 2 });
    draw(ink, "a");
    draw(ink, "b");
    draw(ink, "c");
    expect(ink.undo()).toBe(true);
    expect(ink.undo()).toBe(true);
    expect(ink.undo()).toBe(false);
    expect(ink.snapshot().strokes.map((stroke) => stroke.id)).toEqual(["a"]);
    ink.begin("cancelled", { tool: "draw", params, point: point(0) });
    ink.cancel("cancelled");
    expect(ink.canRedo).toBe(true);
    draw(ink, "d");
    expect(ink.canRedo).toBe(false);
  });

  it("undo leaves live drafts intact and discard creates a permanent history barrier", () => {
    const ink = createInkDocument();
    draw(ink, "a");
    draw(ink, "b");
    ink.begin("live", { tool: "draw", params, point: point(0) });
    const live = ink.snapshot().live[0];
    ink.undo();
    expect(ink.snapshot().live[0]).toBe(live);
    ink.discard(["a"]);
    expect(ink.snapshot().strokes).toEqual([]);
    expect(ink.snapshot().live[0]).toBe(live);
    expect(ink.canUndo).toBe(false);
    expect(ink.canRedo).toBe(false);
  });

  it("clears completed records as one reversible edit while preserving live input", () => {
    const ink = createInkDocument();
    draw(ink, "a");
    draw(ink, "b");
    ink.begin("live", { tool: "draw", params, point: point(0) });
    ink.clear();
    expect(ink.snapshot().strokes).toEqual([]);
    expect(ink.snapshot().live).toHaveLength(1);
    ink.undo();
    expect(ink.snapshot().strokes.map((stroke) => stroke.id)).toEqual(["a", "b"]);
  });
});

describe("InkDocument captures and importing", () => {
  it("captures stable data and retires only unchanged submitted records", () => {
    const ink = createInkDocument({ now: () => 123 });
    draw(ink, "a");
    draw(ink, "b");
    const capture = ink.capture();
    ink.setParams(["b"], { ...params, color: "red" });
    draw(ink, "later");
    ink.retire(capture);
    expect(capture.capturedAt).toBe(123);
    expect(capture.strokes.map((stroke) => stroke.id)).toEqual(["a", "b"]);
    expect(capture.strokes[1].params.color).toBe(params.color);
    expect(ink.snapshot().strokes.map((stroke) => stroke.id)).toEqual(["b", "later"]);
    ink.undo();
    ink.retire(capture);
    // Undo restored "a" with a new revision, so an old request cannot remove it again.
    expect(ink.snapshot().strokes.map((stroke) => stroke.id)).toEqual(["a", "b", "later"]);
  });

  it("supports captures of selected completed records without including active ink", () => {
    const ink = createInkDocument();
    draw(ink, "a");
    draw(ink, "b");
    ink.begin("live", { tool: "draw", params, point: point(0) });
    expect(ink.capture({ ids: ["b", "live"] }).strokes.map((stroke) => stroke.id)).toEqual(["b"]);
    expect(ink.capture({ ids: [] }).strokes).toEqual([]);
  });

  it("does not retire a different document's coincidentally matching IDs and revisions", () => {
    const first = createInkDocument();
    const second = createInkDocument();
    draw(first, "a");
    draw(second, "a");
    second.retire(first.capture());
    expect(second.snapshot().strokes).toHaveLength(1);
  });

  it("imports edited captures in one operation, copies their data, and rejects invalid imports atomically", () => {
    const source = createInkDocument();
    draw(source, "source");
    source.begin("cut", { tool: "erase", params, point: point(20) });
    source.finish("cut");
    const destination = createInkDocument();
    draw(destination, "replace");
    const changes: InkChange[] = [];
    destination.subscribe((change) => changes.push(change));
    const capture = source.capture();
    destination.import(capture.strokes);
    const result = destination.snapshot();
    expect(changes).toHaveLength(1);
    expect(changes[0].kind).toBe("import");
    expect(changes[0].removedIds).toEqual(["replace"]);
    expect(result.strokes[0].erasures).toEqual(capture.strokes[0].erasures);
    expect(result.strokes[0].points).not.toBe(capture.strokes[0].points);
    expect(() => destination.import([capture.strokes[0], capture.strokes[0]])).toThrow("unique");
    expect(destination.snapshot()).toBe(result);
    destination.undo();
    expect(destination.snapshot().strokes.map((stroke) => stroke.id)).toEqual(["replace"]);
  });

  it("maps only eraser coordinates and radius, retaining raw input for inspection", () => {
    const ink = createInkDocument();
    ink.begin("erase", { tool: "erase", params: { ...params, size: 8 }, point: point(30, 40) });
    const draft = ink.snapshot().live[0];
    const coverage = eraserCoverage(draft, { x: 10, y: 20, scale: 2 });
    expect(coverage.points).toEqual([{ x: 10, y: 10, radius: 4 }]);
    expect(draft.points[0].x).toBe(30);
    expect(draft.points[0].width).toBe(2);
  });
});
