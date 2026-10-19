import { agentToolkit } from "@habemus-papadum/aiui-viz";
import { cellHarness, resetControlSurface, whenReady } from "@habemus-papadum/aiui-viz/testing";
import { flush } from "solid-js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { initialDC } from "./dc-circuit";
import { initialDCLayout } from "./dc-layout";
import {
  applyDCReturn,
  changeDC,
  dcAnchor,
  dcHistory,
  dcLayout,
  dcSelection,
  loadDCCase,
  moveDCSymbol,
  redoDC,
  returnRequest,
  selectDC,
  terminalNames,
  undoDC,
  voltageLens,
} from "./dc-store";
import { graph } from "./graph";

beforeEach(() =>
  flush(() => {
    dcHistory.set({ current: initialDC(), past: [], future: [] });
    dcLayout.set(initialDCLayout());
    dcSelection.set("pin/R2/a");
    dcAnchor.set("R2/a");
    returnRequest.set(null);
  }),
);
afterEach(() => resetControlSurface());
it("wiring, resistance and source parameters drive one analysis cell through tool actions", async () => {
  const h = cellHarness(() => graph());
  try {
    const kit = agentToolkit("semantic-svg-lab").handle();
    expect((await whenReady(h.cells.dc)).output).toBeCloseTo(6);
    kit.call("dc/edit", {
      expectedRevision: 0,
      edit: { kind: "resistance", part: "R1", ohms: 2000 },
    });
    expect((await whenReady(h.cells.dc)).output).toBeCloseTo(4);
    changeDC.run({ expectedRevision: 1, edit: { kind: "supply", volts: 18 } });
    expect((await whenReady(h.cells.dc)).output).toBeCloseTo(6);
    changeDC.run({ expectedRevision: 2, edit: { kind: "disconnect", wire: "w3" } });
    expect((await whenReady(h.cells.dc)).output).toBeCloseTo(18);
    loadDCCase.run({ case: "source-short" });
    expect((await whenReady(h.cells.dc)).output).toBeNull();
  } finally {
    h.dispose();
  }
});
it("symbol placement, voltage lens and selection do not recompute physics; terminal identity survives net splits", async () => {
  const h = cellHarness(() => graph());
  try {
    const initial = await whenReady(h.cells.dc),
      structure = await whenReady(h.cells.structure);
    moveDCSymbol.run({ part: "RL", x: 600, y: 300 });
    voltageLens.set(false);
    terminalNames.set(false);
    selectDC.run({ ref: "pin/R2/b" });
    expect(await whenReady(h.cells.dc)).toBe(initial);
    expect(dcAnchor.get()).toBe("R2/b");
    const before = initial.nets[initial.netOf["R2/b"]].pins;
    expect(before).toContain("V1/n");
    changeDC.run({ expectedRevision: 0, edit: { kind: "disconnect", wire: "w3" } });
    const after = await whenReady(h.cells.dc);
    expect(after.nets[after.netOf[dcAnchor.get()]].pins).not.toContain("V1/n");
    expect(dcSelection.get()).toBe("pin/R2/b");
    expect(await whenReady(h.cells.structure)).toBe(structure);
  } finally {
    h.dispose();
  }
});
it("proposals ignore layout changes, reject electrical changes and respect fresh undo revisions", async () => {
  const h = cellHarness(() => graph());
  try {
    await whenReady(h.cells.dc);
    selectDC.run({ ref: "wire/w3" });
    changeDC.run({ expectedRevision: 0, edit: { kind: "disconnect", wire: "w3" } });
    expect(dcSelection.get()).toBe("pin/R2/b");
    const source = dcHistory.get().current;
    flush(() => returnRequest.set({ source, layout: dcLayout.get(), phase: "preview" }));
    moveDCSymbol.run({ part: "R2", x: 450, y: 270 });
    applyDCReturn.run();
    expect((await whenReady(h.cells.dc)).goalMet).toBe(true);
    undoDC.run();
    expect((await whenReady(h.cells.dc)).output).toBeCloseTo(12);
    flush(() => returnRequest.set({ source, layout: dcLayout.get(), phase: "preview" }));
    expect(() => applyDCReturn.run()).toThrow("changed");
    redoDC.run();
    expect((await whenReady(h.cells.dc)).goalMet).toBe(true);
    undoDC.run();
    const n = dcHistory.get().current.nextWire;
    changeDC.run({
      expectedRevision: dcHistory.get().current.revision,
      edit: { kind: "connect", a: "R2/b", b: "V1/n" },
    });
    expect(dcHistory.get().current.wires.at(-1)?.id).toBe(`w${n}`);
    expect(n).toBe(7);
  } finally {
    h.dispose();
  }
});
