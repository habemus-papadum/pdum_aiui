import { agentToolkit } from "@habemus-papadum/aiui-viz";
import { cellHarness, resetControlSurface, whenReady } from "@habemus-papadum/aiui-viz/testing";
import { flush } from "solid-js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { graph } from "./graph";
import { initialStructure } from "./structure";
import {
  applyBrace,
  braceRequest,
  changeStructure,
  explodedJoint,
  focusedJoint,
  forceLens,
  inspectStructure,
  movePreview,
  redoStructure,
  selectStructure,
  showMotion,
  structureHistory,
  structureSelection,
  undoStructure,
} from "./structure-store";

beforeEach(() =>
  flush(() => {
    structureHistory.set({ current: initialStructure(), past: [], future: [] });
    structureSelection.set("joint/D");
    focusedJoint.set("D");
    movePreview.set(null);
    braceRequest.set(null);
  }),
);
afterEach(() => resetControlSurface());
it("topology, geometry, support and load edits each reach the shared analysis cell", async () => {
  const h = cellHarness(() => graph());
  try {
    const initial = await whenReady(h.cells.structure);
    const circuit = await whenReady(h.cells.circuit);
    expect(initial.status).toBe("solved");
    const kit = agentToolkit("semantic-svg-lab").handle();
    kit.call("structure/edit", { expectedRevision: 0, edit: { kind: "remove", member: "m5" } });
    expect((await whenReady(h.cells.structure)).status).toBe("mechanism");
    kit.call("structure/edit", { expectedRevision: 1, edit: { kind: "add", a: "B", b: "D" } });
    expect((await whenReady(h.cells.structure)).status).toBe("solved");
    changeStructure.run({ expectedRevision: 2, edit: { kind: "move", joint: "D", x: 2, y: 3 } });
    expect((await whenReady(h.cells.structure)).model.joints[3]).toMatchObject({ x: 2, y: 3 });
    changeStructure.run({
      expectedRevision: 3,
      edit: { kind: "load", joint: "C", magnitude: 200 },
    });
    expect((await whenReady(h.cells.structure)).forces["R_{By}"]).toBeCloseTo(150);
    changeStructure.run({
      expectedRevision: 4,
      edit: { kind: "support", joint: "B", support: "none" },
    });
    expect((await whenReady(h.cells.structure)).status).toBe("mechanism");
    expect(await whenReady(h.cells.circuit)).toBe(circuit);
  } finally {
    h.dispose();
  }
});
it("view changes preserve results; live motion previews never create a revision or undo step", async () => {
  const h = cellHarness(() => graph());
  try {
    const initial = await whenReady(h.cells.structure);
    forceLens.set(false);
    explodedJoint.set(true);
    showMotion.set(false);
    selectStructure.run({ ref: "member/m5" });
    expect(await whenReady(h.cells.structure)).toBe(initial);
    movePreview.set({ joint: "D", x: 1.8, y: 3, expectedRevision: 0 });
    expect((await whenReady(h.cells.structure)).model.joints[3].x).toBe(1.8);
    expect(structureHistory.get().current.revision).toBe(0);
    expect(structureHistory.get().past).toHaveLength(0);
    movePreview.set(null);
    expect((await whenReady(h.cells.structure)).model.joints[3].x).toBe(1);
  } finally {
    h.dispose();
  }
});
it("removal retires the selection, undo preserves IDs and stale requests cannot write", async () => {
  const h = cellHarness(() => graph());
  try {
    await whenReady(h.cells.structure);
    selectStructure.run({ ref: "member/m5" });
    changeStructure.run({ expectedRevision: 0, edit: { kind: "remove", member: "m5" } });
    expect(structureSelection.get()).toBe("joint/D");
    const source = structureHistory.get().current;
    flush(() => braceRequest.set({ source, brace: { a: "A", b: "C" }, phase: "preview" }));
    undoStructure.run();
    expect(inspectStructure.run()).toMatchObject({ model: { revision: 2 }, status: "solved" });
    expect(() => applyBrace.run()).toThrow("changed");
    redoStructure.run();
    expect((await whenReady(h.cells.structure)).status).toBe("mechanism");
    expect(() =>
      changeStructure.run({ expectedRevision: 0, edit: { kind: "remove", member: "m1" } }),
    ).toThrow("changed");
    changeStructure.run({ expectedRevision: 3, edit: { kind: "add", a: "A", b: "C" } });
    const member = structureHistory.get().current.members.at(-1);
    expect(member).toMatchObject({ id: "m6", a: "A", b: "C" });
    undoStructure.run();
    changeStructure.run({ expectedRevision: 5, edit: { kind: "add", a: "A", b: "C" } });
    expect(structureHistory.get().current.members.at(-1)?.id).toBe("m7");
  } finally {
    h.dispose();
  }
});
