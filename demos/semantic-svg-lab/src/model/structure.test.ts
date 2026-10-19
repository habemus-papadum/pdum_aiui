import { describe, expect, it } from "vitest";
import {
  analyzeStructure,
  editStructure,
  forceFor,
  initialStructure,
  jointById,
  type Structure,
  type StructureEdit,
} from "./structure";

const change = (s: Structure, edit: StructureEdit) => editStructure(s, edit, s.revision);

describe("four-joint equilibrium", () => {
  it("balances every joint, reactions and moment in the initial truss", () => {
    const s = initialStructure();
    const r = analyzeStructure(s);
    expect(r).toMatchObject({ status: "solved", rank: 8, mechanisms: 0, redundancies: 0 });
    // Downward 120 N at x=1, supports x=0 and x=4: Ay=90, By=30.
    expect(r.forces["R_{Ay}"]).toBeCloseTo(90, 9);
    expect(r.forces["R_{By}"]).toBeCloseTo(30, 9);
    expect(r.forces["R_{Ax}"]).toBeCloseTo(0, 9);
    for (const terms of Object.values(r.joints)) {
      expect(terms.reduce((sum, t) => sum + t.x * (t.value ?? NaN), 0)).toBeCloseTo(0, 9);
      expect(terms.reduce((sum, t) => sum + t.y * (t.value ?? NaN), 0)).toBeCloseTo(0, 9);
    }
    expect(r.residual).toBeLessThan(1e-9);
    expect(forceFor(r, s.members[4])).toBeGreaterThan(0);
  });
  it("distinguishes mechanism, load-compatible mechanism and indeterminacy", () => {
    const open = change(initialStructure(), { kind: "remove", member: "m5" });
    const result = analyzeStructure(open);
    expect(result).toMatchObject({
      status: "mechanism",
      mechanisms: 1,
      loadCompatible: false,
      forces: {},
    });
    expect(result.motion).not.toBeNull();
    if (!result.motion) throw new Error("Expected a mechanism witness.");
    // Its reported first-order motion preserves all member lengths and support constraints.
    for (const m of open.members) {
      const a = jointById(open, m.a),
        b = jointById(open, m.b);
      const da = result.motion[m.a],
        db = result.motion[m.b];
      expect((b.x - a.x) * (db.x - da.x) + (b.y - a.y) * (db.y - da.y)).toBeCloseTo(0, 9);
    }
    expect(result.motion.A).toEqual({ x: expect.closeTo(0), y: expect.closeTo(0) });
    expect(result.motion.B.y).toBeCloseTo(0);
    const supportedLoad = change(open, { kind: "load", joint: "A", magnitude: 120 });
    expect(analyzeStructure(supportedLoad)).toMatchObject({
      status: "mechanism",
      loadCompatible: true,
      forces: {},
    });
    const both = change(initialStructure(), { kind: "add", a: "B", b: "D" });
    expect(analyzeStructure(both)).toMatchObject({
      status: "indeterminate",
      mechanisms: 0,
      redundancies: 1,
      forces: {},
    });
  });
  it("handles degenerate geometry and missing supports without inventing forces", () => {
    const coincident = change(initialStructure(), { kind: "move", joint: "D", x: 0, y: 0 });
    expect(analyzeStructure(coincident)).toMatchObject({
      status: "invalid",
      forces: {},
      motion: null,
    });
    const free = change(initialStructure(), { kind: "support", joint: "A", support: "none" });
    expect(analyzeStructure(free).mechanisms).toBe(2);
    const flat = initialStructure();
    flat.joints = flat.joints.map((j) => ({ ...j, y: 0 }));
    expect(analyzeStructure(flat)).toMatchObject({
      status: "mechanism",
      mechanisms: 2,
      redundancies: 2,
    });
    const empty = { ...initialStructure(), members: [] };
    expect(analyzeStructure(empty).status).toBe("mechanism");
  });
  it("responds to geometry, load placement, magnitude and support orientation", () => {
    for (const x of [0.3, 1, 2, 4.5])
      for (const y of [0.2, 1.5, 4]) {
        const s = change(initialStructure(), { kind: "move", joint: "D", x, y });
        const r = analyzeStructure(s);
        if (r.status === "solved") expect(r.residual).toBeLessThan(1e-8);
      }
    const s = change(initialStructure(), { kind: "load", joint: "C", magnitude: 200 });
    expect(analyzeStructure(s).forces["R_{By}"]).toBeCloseTo(150);
    const rotatedSupport = change(s, { kind: "support", joint: "B", support: "roller-x" });
    expect(analyzeStructure(rotatedSupport).status).toBe("mechanism");
  });
});
it("preserves member identity through reconnects and validates topology and revisions", () => {
  const s = initialStructure();
  const next = change(s, { kind: "reconnect", member: "m5", a: "B", b: "D" });
  expect(next.members[4]).toEqual({ id: "m5", a: "B", b: "D" });
  expect(analyzeStructure(next).status).toBe("solved");
  expect(() => editStructure(next, { kind: "remove", member: "m5" }, 0)).toThrow("changed");
  expect(() => change(s, { kind: "add", a: "A", b: "B" })).toThrow("exists");
  expect(() => change(s, { kind: "add", a: "A", b: "A" })).toThrow("different");
  expect(() => change(s, { kind: "remove", member: "absent" })).toThrow("Unknown");
  expect(() => change(s, { kind: "move", joint: "A", x: Number.NaN, y: 0 })).toThrow("finite");
  expect(s.revision).toBe(0);
});
