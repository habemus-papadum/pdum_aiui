import { cellHarness, resetControlSurface, whenReady } from "@habemus-papadum/aiui-viz/testing";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  alignPair,
  holdPair,
  movePair,
  pairSelection,
  pairZoom,
  radiusA,
  radiusB,
  resetPair,
  setPairPose,
} from "./circle-pair-store";
import { graph } from "./graph";

beforeEach(() => {
  resetPair.run();
});
afterEach(() => resetControlSurface());
it("each radius, pose and tangency relation updates the same geometry", async () => {
  const h = cellHarness(() => graph());
  try {
    expect((await whenReady(h.cells.pair)).gap).toBe(55);
    radiusA.set(80);
    expect((await whenReady(h.cells.pair)).gap).toBe(45);
    radiusB.set(50);
    expect((await whenReady(h.cells.pair)).gap).toBe(40);
    holdPair.run({ enabled: true });
    setPairPose.run({ distance: 200, angle: 90 });
    expect(await whenReady(h.cells.pair)).toMatchObject({ distance: 130, angle: 90, gap: 0 });
    radiusB.set(60);
    const held = await whenReady(h.cells.pair);
    expect(held.distance).toBe(140);
    expect(held.facingA).toEqual(held.facingB);
    holdPair.run({ enabled: false });
    expect((await whenReady(h.cells.pair)).centerB).toEqual(held.centerB);
    movePair.run({ x: -140, y: 0 });
    expect((await whenReady(h.cells.pair)).angle).toBe(-180);
  } finally {
    h.dispose();
  }
});
it("coincident centres cannot silently invent a normal when enabling tangency", async () => {
  const h = cellHarness(() => graph());
  try {
    alignPair.run();
    expect((await whenReady(h.cells.pair)).normal).toBeNull();
    expect(() => holdPair.run({ enabled: true })).toThrow(/choose a contact direction/);
    radiusB.set(70);
    expect((await whenReady(h.cells.pair)).relation).toBe("coincident");
    movePair.run({ x: 10, y: 0 });
    expect((await whenReady(h.cells.pair)).normal).toEqual({ x: 1, y: 0 });
  } finally {
    h.dispose();
  }
});
it("attention and unrelated experiments do not recompute the pair", async () => {
  const h = cellHarness(() => graph());
  try {
    const pair = await whenReady(h.cells.pair);
    const contact = await whenReady(h.cells.contact);
    pairSelection.set("a");
    pairZoom.set(1);
    expect(await whenReady(h.cells.pair)).toBe(pair);
    radiusA.set(90);
    await whenReady(h.cells.pair);
    expect(await whenReady(h.cells.contact)).toBe(contact);
  } finally {
    h.dispose();
  }
});
