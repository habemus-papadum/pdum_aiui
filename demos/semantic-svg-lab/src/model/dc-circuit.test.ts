import { describe, expect, it } from "vitest";
import {
  analyzeDC,
  type DCCircuit,
  type DCEdit,
  editDC,
  initialDC,
  netTerms,
  RESISTORS,
} from "./dc-circuit";
import { initialDCLayout, moveDCPart, pinPosition, wirePoints } from "./dc-layout";

const edit = (s: DCCircuit, e: DCEdit) => editDC(s, e, s.revision);
describe("loaded divider and arbitrary wiring of its fixed parts", () => {
  it("solves the loaded divider and conserves current and power", () => {
    const r = analyzeDC(initialDC());
    expect(r.status).toBe("solved");
    expect(r.goalMet).toBe(true);
    expect(r.output).toBeCloseTo(6, 10);
    expect(r.sourceCurrent).toBeCloseTo(0.006, 10);
    expect(r.branches.R1.current).toBeCloseTo(0.006, 10);
    expect(r.branches.R2.current).toBeCloseTo(0.003, 10);
    expect(r.branches.RL.current).toBeCloseTo(0.003, 10);
    expect(r.kclResidual).toBeLessThan(1e-12);
    expect(Math.abs(r.powerResidual ?? Infinity)).toBeLessThan(1e-12);
    for (const net of r.nets)
      expect(
        netTerms(r, net.pins[0]).reduce((sum, t) => sum + t.sign * (t.current ?? NaN), 0),
      ).toBeCloseTo(0, 10);
  });
  it("an open return can have a defined 12 V output and zero current", () => {
    const r = analyzeDC(edit(initialDC(), { kind: "disconnect", wire: "w3" }));
    expect(r.status).toBe("solved");
    expect(r.output).toBeCloseTo(12, 10);
    expect(r.goalMet).toBe(false);
    expect(r.sourceCurrent).toBeCloseTo(0, 10);
    expect(r.diagnostics.some((d) => d.id === "no-load-path")).toBe(true);
    expect(r.netOf["R2/b"]).not.toBe(r.netOf["V1/n"]);
  });
  it("a disconnected floating load does not erase the valid unloaded-divider solution", () => {
    const r = analyzeDC(edit(initialDC(), { kind: "detach-load" }));
    expect(r.status).toBe("floating");
    expect(r.output).toBeCloseTo(8, 10);
    expect(r.sourceCurrent).toBeCloseTo(0.004, 10);
    expect(r.voltages["RL/a"]).toBeNull();
    expect(r.branches.RL.current).toBe(0);
    expect(r.branches.RL.drop).toBe(0);
    expect(r.goalMet).toBe(false);
    expect(r.diagnostics.find((d) => d.id.startsWith("floating"))?.refs).toContain("pin/RL/a");
  });
  it("shorting the ideal supply has no solution; bypassing a resistor is a different case", () => {
    const short = analyzeDC(edit(initialDC(), { kind: "connect", a: "V1/p", b: "V1/n" }));
    expect(short.status).toBe("short");
    expect(short.output).toBeNull();
    expect(short.sourceCurrent).toBeNull();
    for (const branch of Object.values(short.branches)) expect(branch.current).toBeNull();
    const bypass = analyzeDC(edit(initialDC(), { kind: "connect", a: "R1/a", b: "R1/b" }));
    expect(bypass.status).toBe("solved");
    expect(bypass.output).toBeCloseTo(12);
    expect(bypass.branches.R1.current).toBe(0);
    expect(bypass.diagnostics.some((d) => d.id === "bypassed-R1")).toBe(true);
  });
  it("preserves KCL and power for every subset of fixture wires and bounded resistance values", () => {
    for (let mask = 0; mask < 32; mask++)
      for (const ohms of [100, 1000, 100000]) {
        const s = initialDC();
        s.wires = s.wires.filter((_, i) => mask & (1 << i));
        s.resistance.R1 = ohms;
        const r = analyzeDC(s);
        expect(r.status).not.toBe("numerical");
        expect(r.kclResidual).toBeLessThan(1e-9);
        if (r.powerResidual !== null) expect(Math.abs(r.powerResidual)).toBeLessThan(1e-9);
        for (const branch of Object.values(r.branches))
          if (branch.power !== null) expect(branch.power).toBeGreaterThanOrEqual(-1e-12);
      }
  });
  it("handles cyclic wires without inventing a per-wire current", () => {
    const s = edit(initialDC(), { kind: "connect", a: "R1/b", b: "RL/a" });
    expect(analyzeDC(s).output).toBeCloseTo(6);
    expect(analyzeDC(s).nets).toHaveLength(3);
    expect(analyzeDC(edit(s, { kind: "disconnect", wire: "w2" })).output).toBeCloseTo(6);
  });
  it("validates edits, keeps a reconnected wire's identity and refuses stale proposals", () => {
    const s = edit(initialDC(), { kind: "reconnect", wire: "w3", a: "R2/b", b: "V1/p" });
    expect(s.wires.find((w) => w.id === "w3")).toMatchObject({ a: "R2/b", b: "V1/p" });
    expect(analyzeDC(s).output).toBeCloseTo(12);
    expect(() => editDC(s, { kind: "disconnect", wire: "w1" }, 0)).toThrow("changed");
    expect(() => edit(s, { kind: "connect", a: "R2/b", b: "V1/p" })).toThrow("already");
    expect(() => edit(s, { kind: "connect", a: "R2/b", b: "R2/b" })).toThrow("different");
    expect(() => edit(s, { kind: "reconnect", wire: "", a: "R2/b", b: "V1/n" })).toThrow("Unknown");
    for (const part of RESISTORS)
      expect(() => edit(s, { kind: "resistance", part, ohms: 0 })).toThrow("resistance");
    expect(() => edit(s, { kind: "supply", volts: NaN })).toThrow("Supply");
  });
});
it("symbol placement changes wire endpoints without changing source connectivity", () => {
  const model = initialDC(),
    layout = initialDCLayout();
  const moved = moveDCPart(layout, "R2", 450, 260);
  expect(pinPosition(moved, "R2/a")).toEqual({ x: 450, y: 210 });
  expect(wirePoints(moved, model.wires[1]).at(-1)).toEqual({ x: 450, y: 210 });
  expect(analyzeDC(model).output).toBeCloseTo(6);
});
