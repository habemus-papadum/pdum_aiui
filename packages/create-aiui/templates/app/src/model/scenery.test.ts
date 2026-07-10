// <aiui-scenery-file> — this WHOLE FILE is placeholder scenery: delete it on reset (CLAUDE.md § Reset).
/**
 * scenery.test.ts — the playbook's layer 2 in miniature: controls + cells +
 * the derived agent tools, tested together and headless.
 *
 * Three patterns to copy into your real app's tests:
 *  1. build cells INSIDE `cellHarness(...)` (it provides the reactive owner);
 *  2. `resetControlSurface()` in afterEach — controls are module-and-window
 *     state by design (that's what makes them survive hot edits);
 *  3. probe each input (`set` → `whenReady` → assert the output moved) — the
 *     test that catches a dependency the deps function forgot to declare.
 *
 * The compiler runs under Vitest (see vitest.config.ts), so the controls'
 * names, descriptions, and definition sites below are the injected ones.
 */
import { agentToolkit, registerStandardTools } from "@habemus-papadum/aiui-viz";
import {
  type CellHarness,
  cellHarness,
  resetControlSurface,
  whenReady,
} from "@habemus-papadum/aiui-viz/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type SceneryCells, sceneryCells } from "./scenery";
import { angleStep, petals } from "./store";

let h: CellHarness<SceneryCells> | undefined;
afterEach(() => {
  h?.dispose();
  h = undefined;
  resetControlSurface();
});

describe("the rose (controls + cell + derived tools)", () => {
  it("recomputes when EACH control moves, with writes validated by the meta", async () => {
    h = cellHarness(sceneryCells);
    const first = await whenReady(h.cells.rose);

    expect(angleStep.set(400)).toBe(179); // clamped by the control's own meta…
    const second = await whenReady(h.cells.rose);
    expect(second.walk).not.toBe(first.walk); // …and the cell noticed

    petals.set((n) => (n === 9 ? 2 : n + 1)); // probe the other input too
    const third = await whenReady(h.cells.rose);
    expect(third.walk).not.toBe(second.walk);
  });

  it("the agent's view: report sees the surface, set drives it, the action is a tool", async () => {
    h = cellHarness(sceneryCells);
    await whenReady(h.cells.rose);

    const kit = agentToolkit("starterTest");
    registerStandardTools(kit);

    const brief = kit.handle().call("report") as {
      controls: Record<string, unknown>;
      actions: string[];
      cells: Record<string, string>;
      edges: Record<string, string[]>;
    };
    expect(brief.controls).toMatchObject({ petals: 6, angleStep: 71 });
    expect(brief.actions).toContain("re-flower");
    expect(brief.cells).toMatchObject({ rose: "ready" });
    // The dependency edges: which controls this cell's deps actually read.
    expect(brief.edges.rose).toEqual(["control:petals", "control:angleStep"]);

    // Descriptions arrive from the doc comments in store.ts, compiler-lifted.
    const full = kit.handle().call("report", { format: "full" }) as {
      controls: Array<{ name: string; description?: string }>;
    };
    expect(full.controls.find((c) => c.name === "petals")?.description).toBe(
      "Petal frequency n of the rose r = sin(n·θ).",
    );

    const written = kit.handle().call("set", { name: "petals", value: 99 }) as { value: number };
    expect(written.value).toBe(9); // same clamp as the slider — one validation path

    const flowered = kit.handle().call("re-flower") as { petals: number; step: number };
    expect(flowered.petals).toBeGreaterThanOrEqual(2);
    expect(flowered.petals).toBeLessThanOrEqual(9);
  });
});
