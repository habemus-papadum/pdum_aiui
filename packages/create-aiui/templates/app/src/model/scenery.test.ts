// <aiui-scenery-file> — this WHOLE FILE is placeholder scenery: delete it on reset (CLAUDE.md § Reset).
/**
 * scenery.test.ts — the playbook's layer 2 in miniature: the cell graph,
 * tested headless with `@habemus-papadum/aiui-viz/testing`. No browser, no
 * rendering — just "move each input, prove the graph noticed", which is the
 * probe that catches a dependency the deps function forgot to declare (the
 * one silent failure mode cells have).
 *
 * When you build your real graph, test it exactly like this: one
 * `cellHarness(...)` per test, one `whenReady` per probe, one probe per input.
 */
import { type CellHarness, cellHarness, whenReady } from "@habemus-papadum/aiui-viz/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type SceneryCells, sceneryCells } from "./scenery";
import { angleStep, petals } from "./store";

let h: CellHarness<SceneryCells> | undefined;
afterEach(() => {
  h?.dispose();
  h = undefined;
});

describe("the rose cell (headless, layer 2)", () => {
  it("recomputes when EACH parameter moves", async () => {
    h = cellHarness(sceneryCells);
    const first = await whenReady(h.cells.rose);

    angleStep.set(angleStep.get() + 1); // probe input 1…
    const second = await whenReady(h.cells.rose);
    expect(second.walk).not.toBe(first.walk); // …the graph noticed

    petals.set(petals.get() === 9 ? 2 : petals.get() + 1); // probe input 2…
    const third = await whenReady(h.cells.rose);
    expect(third.walk).not.toBe(second.walk); // …noticed again
  });
});
