import { describe, expect, it } from "vitest";
import {
  commit,
  editResistance,
  features,
  initialCircuit,
  parseCircuit,
  resolveFeature,
  travel,
} from "./circuit";
import {
  cameraFor,
  contains,
  lensBox,
  lensCamera,
  project,
  unproject,
  viewportBounds,
} from "./projection";

describe("identities and edits", () => {
  it("distinguishes repeated parts and preserves hidden pin connectivity", () => {
    const all = features();
    expect(new Set(all.map((feature) => feature.key)).size).toBe(all.length);
    expect(resolveFeature("a/M1/bulk")).toMatchObject({ hidden: true, net: "ground" });
    expect(resolveFeature("a/R1/lower").net).toBe(resolveFeature("b/M1/gate").net);
    expect(resolveFeature("a/R1/value").point).not.toEqual(resolveFeature("b/R1/value").point);
  });
  it("edits exactly one occurrence and leaves feature identities unchanged", () => {
    const before = initialCircuit();
    const after = editResistance(before, "a/R1/value", 6800, 0);
    expect(after.stages.a.resistance).toBe(6800);
    expect(after.stages.b).toBe(before.stages.b);
    expect(before.stages.a.resistance).toBe(4700);
    expect(after.revision).toBe(1);
    expect(editResistance(after, "a/R1/value", 6800, 1)).toBe(after);
  });
  it("refuses stale edits, ambiguous targets, unsupported values and malformed saves", () => {
    for (const value of [NaN, Infinity, 0, -100, 100100, 125]) {
      expect(() => editResistance(initialCircuit(), "a/R1/value", value, 0)).toThrow();
    }
    expect(() => editResistance(initialCircuit(), "R1/value", 5000, 0)).toThrow();
    expect(() => editResistance(initialCircuit(), "a/M1/gate", 5000, 0)).toThrow();
    expect(() => editResistance(initialCircuit(), "a/R1/value", 5000, 1)).toThrow();
    expect(() => parseCircuit({ revision: 0, stages: {} })).toThrow();
    expect(parseCircuit(JSON.parse(JSON.stringify(initialCircuit())))).toEqual(initialCircuit());
  });
  it("undo and redo restore values with fresh revisions, so old proposals stay stale", () => {
    const current = initialCircuit();
    const edited = commit(
      { current, past: [], future: [] },
      editResistance(current, "a/R1/value", 6800, 0),
    );
    const undone = travel(edited, "undo");
    expect(undone.current).toMatchObject({ revision: 2, stages: { a: { resistance: 4700 } } });
    const redone = travel(undone, "redo");
    expect(redone.current).toMatchObject({ revision: 3, stages: { a: { resistance: 6800 } } });
    expect(() => editResistance(redone.current, "b/R1/value", 2200, 1)).toThrow();
    const fork = commit(undone, editResistance(undone.current, "b/R1/value", 2200, 2));
    expect(fork.future).toEqual([]);
  });
});

describe("view geometry", () => {
  it.each([
    320, 390, 850, 1200,
  ])("maps pointing through the lens back to the same feature at width %s", (width) => {
    const size = { width, height: 520 };
    const box = lensBox(size, { x: 0.3, y: 0.48 });
    expect(box.x).toBeGreaterThanOrEqual(12);
    expect(box.x + box.width).toBeLessThanOrEqual(width - 12);
    for (const zoom of [1, 1.6, 3]) {
      const camera = cameraFor(size, zoom, { x: 70, y: -30 });
      const lens = lensCamera(camera, box, 1.6);
      const p = resolveFeature("a/M1/bulk").point;
      const inverse = unproject(project(p, lens), lens);
      expect(inverse.x).toBeCloseTo(p.x, 10);
      expect(inverse.y).toBeCloseTo(p.y, 10);
      const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      expect(unproject(center, camera).x).toBeCloseTo(unproject(center, lens).x);
      expect(contains(box, center)).toBe(true);
      const bounds = viewportBounds(camera, size);
      expect(project(bounds, camera).x).toBeCloseTo(0, 10);
      expect(project(bounds, camera).y).toBeCloseTo(0, 10);
      expect(bounds.width * camera.scale).toBeCloseTo(width);
    }
  });
});
