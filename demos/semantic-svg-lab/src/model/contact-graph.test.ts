import { agentToolkit } from "@habemus-papadum/aiui-viz";
import { cellHarness, resetControlSurface, whenReady } from "@habemus-papadum/aiui-viz/testing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { contactSelection, holdTangency, moveCircle, radius, resetContact } from "./contact-store";
import { graph } from "./graph";

beforeEach(() => {
  resetContact.run();
});
afterEach(() => resetControlSurface());
it("the shared radius, movement, and constraint each recompute contact geometry", async () => {
  const h = cellHarness(() => graph());
  try {
    expect((await whenReady(h.cells.contact)).gap).toBe(80);
    const kit = agentToolkit("semantic-svg-lab").handle();
    kit.call("set", { name: radius.name, value: 80 });
    expect((await whenReady(h.cells.contact)).gap).toBe(60);
    moveCircle.run({ x: 40, y: 79.5 });
    expect(await whenReady(h.cells.contact)).toMatchObject({
      state: "crossing",
      gap: -0.5,
      center: { x: 40, y: 79.5 },
    });
    holdTangency.run({ enabled: true });
    expect((await whenReady(h.cells.contact)).gap).toBe(0);
    radius.set(90);
    expect(await whenReady(h.cells.contact)).toMatchObject({ height: 90, radius: 90, gap: 0 });
    moveCircle.run({ x: 70, y: 200 });
    expect((await whenReady(h.cells.contact)).center).toEqual({ x: 70, y: 90 });
    holdTangency.run({ enabled: false });
    expect((await whenReady(h.cells.contact)).center).toEqual({ x: 70, y: 90 });
    moveCircle.run({ x: 70, y: 110 });
    expect((await whenReady(h.cells.contact)).gap).toBe(20);
    expect(kit.call("contact/inspect")).toMatchObject({ gap: 20, units: "mm" });
  } finally {
    h.dispose();
  }
});
it("attention changes do not recompute geometry or the unrelated circuit", async () => {
  const h = cellHarness(() => graph());
  try {
    const before = await whenReady(h.cells.contact);
    const circuit = await whenReady(h.cells.circuit);
    contactSelection.set("radius");
    expect(await whenReady(h.cells.contact)).toBe(before);
    moveCircle.run({ x: 100, y: 100 });
    await whenReady(h.cells.contact);
    expect(await whenReady(h.cells.circuit)).toBe(circuit);
  } finally {
    h.dispose();
  }
});

it("a move consumes a control write made earlier in the same tool batch", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    radius.set(80);
    holdTangency.run({ enabled: true });
    expect(moveCircle.run({ x: 30, y: 190 })).toMatchObject({ radius: 80, height: 80, gap: 0 });
    expect(error).not.toHaveBeenCalled();
  } finally {
    error.mockRestore();
  }
});
