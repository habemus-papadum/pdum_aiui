import {
  applyTransform,
  createInkDocument,
  type InkDocument,
  type PenSample,
  WRITE,
} from "@habemus-papadum/aiui-pencil/core";
import { describe, expect, it } from "vitest";
import { editResistance, initialCircuit, resolveFeature } from "./circuit";
import {
  attachInk,
  type FrozenView,
  freezeView,
  laterStrokes,
  proposalIsStale,
  propose,
} from "./markup";

export function stroke(
  document: InkDocument,
  id: string,
  from = { x: 150, y: 150 },
  to = { x: 180, y: 165 },
) {
  const sample = (point: { x: number; y: number }, t: number): PenSample => ({
    ...point,
    t,
    pressure: 0.6,
    altitude: Math.PI / 2,
    azimuth: 0,
    twist: 0,
    kind: "pen",
    width: 1,
    height: 1,
  });
  document.begin(id, { tool: "draw", params: WRITE, point: sample(from, 0) });
  document.append(id, [sample(to, 30)]);
  document.finish(id, sample(to, 40));
}
export function viewFixture(): FrozenView {
  return {
    image: "frozen-svg",
    size: { width: 800, height: 520 },
    camera: { x: 10, y: 20, scale: 1 },
    lens: {
      box: { x: 100, y: 100, width: 200, height: 200 },
      camera: { x: -40, y: -60, scale: 2 },
    },
    target: "a/R1/value",
    circuit: initialCircuit(),
  };
}

describe("captured requests", () => {
  it("preserves the source view, target, revision and ink when the live state changes", () => {
    const live = viewFixture();
    const view = freezeView(live);
    const doc = createInkDocument();
    stroke(doc, "request");
    const capture = doc.capture();
    live.target = "b/R1/value";
    live.camera.x = 300;
    live.circuit.stages.a.resistance = 8200;
    stroke(doc, "later");
    doc.setParams(["request"], { ...WRITE, size: 4 });
    expect(view.target).toBe("a/R1/value");
    expect(view.camera.x).toBe(10);
    expect(view.circuit.stages.a.resistance).toBe(4700);
    expect(capture.strokes).toHaveLength(1);
    expect(capture.strokes[0].params.size).toBe(WRITE.size);
    expect(laterStrokes(capture, doc.snapshot().strokes)).toBe(1);
    doc.retire(capture);
    expect(doc.snapshot().strokes.map((item) => item.id)).toEqual(["request", "later"]);
  });
  it("projects eligible ink into target-local coordinates and leaves boundary-crossing ink in evidence", () => {
    const doc = createInkDocument();
    stroke(doc, "in-lens");
    stroke(doc, "main", { x: 400, y: 350 }, { x: 450, y: 360 });
    stroke(doc, "crossing", { x: 80, y: 150 }, { x: 330, y: 150 });
    const capture = doc.capture();
    const result = attachInk(capture, viewFixture());
    expect(result.attached).toBe(2);
    expect(result.capturedOnly).toBe(1);
    expect(capture.strokes).toHaveLength(3);
    const anchor = resolveFeature("a/R1/value").point;
    const mapped = applyTransform(
      capture.strokes[0].points[0],
      result.capture.strokes[0].transform,
    );
    expect(mapped.x + anchor.x).toBeCloseTo((150 + 40) / 2);
    expect(mapped.y + anchor.y).toBeCloseTo((150 + 60) / 2);
    expect(result.capture.strokes[0].points).toBe(capture.strokes[0].points);
    expect(result.bounds.width).toBeGreaterThan(0);
  });
  it("explicit review preserves original evidence and request while advancing the expected revision", () => {
    const view = freezeView(viewFixture());
    const original = propose(view);
    const newer = editResistance(view.circuit, "a/R1/value", 8200, 0);
    expect(proposalIsStale(original, newer)).toBe(true);
    const reviewed = propose(view, newer, true);
    expect(reviewed).toMatchObject({
      before: 8200,
      after: 6800,
      expectedRevision: 1,
      evidenceRevision: 0,
      reviewed: true,
    });
    expect(view.circuit.stages.a.resistance).toBe(4700);
    expect(proposalIsStale(reviewed, newer)).toBe(false);
  });
});
