import { agentToolkit } from "@habemus-papadum/aiui-viz";
import { cellHarness, resetControlSurface, whenReady } from "@habemus-papadum/aiui-viz/testing";
import { flush } from "solid-js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { initialCircuit } from "./circuit";
import { graph } from "./graph";
import {
  history,
  lensPosition,
  lensVisible,
  magnification,
  pan,
  selected,
  setResistance,
  zoom,
} from "./store";

beforeEach(() =>
  flush(() => {
    history.set({ current: initialCircuit(), past: [], future: [] });
    selected.set("a/R1/value");
    pan.set({ x: 0, y: 0 });
    lensPosition.set({ x: 0.25, y: 0.5 });
  }),
);
afterEach(() => resetControlSurface());

it("an agent edit updates both derived views and the semantic report", async () => {
  const h = cellHarness(() => graph());
  try {
    await whenReady(h.cells.circuit);
    const tools = agentToolkit("semantic-svg-lab").handle();
    tools.call("set-resistance", { key: "a/R1/value", ohms: 6800, expectedRevision: 0 });
    expect((await whenReady(h.cells.circuit)).stages).toEqual([
      { occurrence: "a", resistance: 6800 },
      { occurrence: "b", resistance: 10000 },
    ]);
    expect((await whenReady(h.cells.inspection)).resistance).toBe(6800);
    expect(tools.call("inspect-circuit")).toMatchObject({ revision: 1, undoSteps: 1 });
    tools.call("undo");
    expect((await whenReady(h.cells.inspection)).resistance).toBe(4700);
    tools.call("redo");
    expect((await whenReady(h.cells.inspection)).resistance).toBe(6800);
    expect(() =>
      setResistance.run({ key: "a/R1/value", ohms: 2200, expectedRevision: 0 }),
    ).toThrow();
  } finally {
    h.dispose();
  }
});

it("selection changes inspection without invalidating the circuit projection", async () => {
  const h = cellHarness(() => graph());
  try {
    const before = await whenReady(h.cells.circuit);
    agentToolkit("semantic-svg-lab")
      .handle()
      .call("select-feature", { key: "b/M1/bulk", view: "lens" });
    expect(await whenReady(h.cells.inspection)).toMatchObject({
      key: "b/M1/bulk",
      hidden: true,
      net: "ground",
    });
    expect(await whenReady(h.cells.circuit)).toBe(before);
  } finally {
    h.dispose();
  }
});

it("all navigation inputs leave circuit results and edit history unchanged", async () => {
  const h = cellHarness(() => graph());
  try {
    const before = await whenReady(h.cells.circuit);
    for (const move of [
      () => zoom.set(1.7),
      () => magnification.set(2),
      () => lensVisible.set(false),
      () => pan.set({ x: 100, y: 40 }),
      () => lensPosition.set({ x: 0.7, y: 0.5 }),
    ]) {
      flush(() => {
        move();
      });
      expect(await whenReady(h.cells.circuit)).toBe(before);
      expect(history.get().past).toHaveLength(0);
    }
  } finally {
    h.dispose();
  }
});
