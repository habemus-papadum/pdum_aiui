import { agentToolkit } from "@habemus-papadum/aiui-viz";
import { cellHarness, resetControlSurface, whenReady } from "@habemus-papadum/aiui-viz/testing";
import { flush } from "solid-js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { graph } from "./graph";
import { beamSelection, freeBody, load, loadPosition, resetBeam } from "./statics-store";

beforeEach(() => {
  resetBeam.run();
});
afterEach(() => resetControlSurface());
it("both load and position update the analytic solution through the shared control surface", async () => {
  const h = cellHarness(() => graph());
  try {
    expect(await whenReady(h.cells.statics)).toMatchObject({ left: 84, right: 36 });
    load.set(200);
    expect(await whenReady(h.cells.statics)).toMatchObject({ left: 140, right: 60 });
    loadPosition.set(50);
    expect(await whenReady(h.cells.statics)).toMatchObject({ left: 100, right: 100, distance: 2 });
    const kit = agentToolkit("semantic-svg-lab").handle();
    kit.call("set", { name: load.name, value: 160 });
    expect(kit.call("statics/inspect")).toMatchObject({ load: 160, left: 80, right: 80 });
    expect(await whenReady(h.cells.statics)).toMatchObject({ left: 80, right: 80 });
  } finally {
    h.dispose();
  }
});
it("free-body presentation and selection leave the physical result unchanged", async () => {
  const h = cellHarness(() => graph());
  try {
    const before = await whenReady(h.cells.statics);
    const contact = await whenReady(h.cells.contact);
    flush(() => {
      freeBody.set(true);
      beamSelection.set("right");
    });
    expect(await whenReady(h.cells.statics)).toBe(before);
    loadPosition.set(90);
    await whenReady(h.cells.statics);
    expect(await whenReady(h.cells.contact)).toBe(contact);
  } finally {
    h.dispose();
  }
});
