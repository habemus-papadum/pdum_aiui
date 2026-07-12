/**
 * The panel's model layer, tested headless per the frontend-design
 * methodology: cells built INSIDE `cellHarness`, `resetControlSurface` in
 * afterEach, one per-input probe per cell (the instrument that catches an
 * undeclared dependency). Chrome APIs are stubbed — the cells' realm is the
 * panel document, and only these three calls cross into extension land.
 */
import {
  type CellHarness,
  cellHarness,
  resetControlSurface,
  whenReady,
} from "@habemus-papadum/aiui-viz/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type PanelCells, panelCells } from "./graph";
import { inkFade, rescanTick, shotFlash } from "./store";

/** A chrome stub: native host answers two channels; SW relay pongs. */
let nativeCalls = 0;
let pingCalls = 0;
beforeEach(() => {
  nativeCalls = 0;
  pingCalls = 0;
  vi.stubGlobal("chrome", {
    runtime: {
      sendNativeMessage: async () => {
        nativeCalls += 1;
        return {
          ok: true,
          channels: [
            { tag: "t1", port: 4001, pid: 1, cwd: "/a", startedAt: "x" },
            { tag: "t2", port: 4002, pid: 2, cwd: "/b", startedAt: "y" },
          ],
        };
      },
      sendMessage: async () => {
        pingCalls += 1;
        return { ok: true, value: { at: "2026-07-12T00:00:00.000Z" } };
      },
    },
  });
});

let h: CellHarness<PanelCells> | undefined;
afterEach(() => {
  h?.dispose();
  h = undefined;
  resetControlSurface();
  vi.unstubAllGlobals();
});

describe("the panel graph (cells + the rescan input)", () => {
  it("discovers channels via the native host and re-runs when the tick moves", async () => {
    h = cellHarness(panelCells);
    const first = await whenReady(h.cells.channels);
    expect(first.source).toBe("native");
    expect(first.list.map((c) => c.port)).toEqual([4001, 4002]);

    // The per-input probe: the tick IS a declared dependency, so bumping it
    // re-runs the compute (exact run counts are the machinery's business).
    const before = nativeCalls;
    rescanTick.set(rescanTick.get() + 1); // the rescan action's whole body
    await whenReady(h.cells.channels);
    expect(nativeCalls).toBeGreaterThan(before);
  });

  it("probes the service worker and re-probes on the same tick", async () => {
    h = cellHarness(panelCells);
    const pong = await whenReady(h.cells.swPing);
    expect(pong.at).toContain("2026-07-12");

    const before = pingCalls;
    rescanTick.set(rescanTick.get() + 1);
    await whenReady(h.cells.swPing);
    expect(pingCalls).toBeGreaterThan(before);
  });
});

describe("the control surface", () => {
  it("declares the knobs with compiler-injected names and store-owned bounds", () => {
    // Names are injected from the bindings by the aiui compiler (wired in
    // vitest.config.ts) — if these fail, the compiler isn't running.
    expect(inkFade.name).toBe("inkFade");
    expect(shotFlash.name).toBe("shotFlash");
    expect(inkFade.set(99)).toBe(20); // clamped by the declaration's max
    expect(inkFade.set(0)).toBe(2); // …and the 2s floor (vanish's slider)
  });
});
