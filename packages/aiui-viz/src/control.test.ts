// @vitest-environment jsdom
/**
 * control.test.ts — the control surface: declaration, validation, durability,
 * dependency edges, and the derived agent tools. These double as the worked
 * examples for testing an app's controls (resetControlSurface between cases —
 * controls are deliberately module-and-window state).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentToolkit } from "./agent-tools";
import { cell } from "./cell";
import { action, clearControlSurface, control, controlSurface } from "./control";
import { dependencyEdges } from "./graph-trace";
import { registerStandardTools } from "./standard-tools";
import { type CellHarness, cellHarness, tick, whenReady } from "./testing";

let h: CellHarness<object> | undefined;
afterEach(() => {
  h?.dispose();
  h = undefined;
  hardResetControlSurface();
  vi.restoreAllMocks();
});

import { disposeDurable } from "./durable";
import { resetDependencyEdges } from "./graph-trace";

/** Library-internal hard reset: these tests declare FRESH controls per case. */
function hardResetControlSurface(): void {
  const { durableKeys } = clearControlSurface();
  for (const key of durableKeys) {
    disposeDurable(key);
  }
  resetDependencyEdges();
}

describe("control(): identity", () => {
  it("throws loudly without a name — the compiler or the pedantic form must supply it", () => {
    expect(() => control({ value: 1 })).toThrow(/needs a name/);
  });

  it("registers with description/loc and reports through controlSurface()", () => {
    control({
      name: "kappa",
      value: 0.1,
      description: "Diffusion constant",
      loc: "src/model/store.ts:2",
      min: 0.01,
      max: 1,
    });
    const [entry] = controlSurface();
    expect(entry).toMatchObject({
      kind: "control",
      name: "kappa",
      value: 0.1,
      description: "Diffusion constant",
      loc: "src/model/store.ts:2",
      meta: { min: 0.01, max: 1 },
    });
  });

  it("re-registration replaces by name (HMR) and warns only when the loc differs", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    control({ name: "kappa", value: 0.1, loc: "src/store.ts:2" });
    control({ name: "kappa", value: 0.1, loc: "src/store.ts:2" }); // HMR re-eval: same site
    expect(warn).not.toHaveBeenCalled();
    control({ name: "kappa", value: 0.5, loc: "src/other.ts:9" }); // a genuine collision
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('control "kappa" re-registered'));
  });

  it("is durable: a re-declaration (hot edit) adopts the existing value", async () => {
    const first = control({ name: "kappa", value: 0.1 });
    first.set(0.7);
    await tick(); // writes are batched

    const second = control({ name: "kappa", value: 0.1 }); // module re-evaluates
    expect(second.get()).toBe(0.7); // NOT reset to the initial value
  });
});

describe("control(): validation lives in one place", () => {
  it("clamps numbers to min/max and snaps to step (with float cleanup)", async () => {
    const kappa = control({ name: "kappa", value: 0.1, min: 0.01, max: 1, step: 0.01 });
    expect(kappa.set(2 as never)).toBe(1); // clamped, and the WRITTEN value returned
    expect(kappa.set(0.123456 as never)).toBe(0.12); // snapped to the step grid
    await tick();
    expect(kappa.get()).toBe(0.12);
  });

  it("rejects wrong types and non-finite numbers", () => {
    const kappa = control({ name: "kappa", value: 0.1 });
    expect(() => kappa.set("fast" as never)).toThrow(/expected number, got string/);
    expect(() => kappa.set(Number.NaN as never)).toThrow(/finite/);
  });

  it("enforces enum options", () => {
    const scheme = control({
      name: "scheme",
      value: "explicit",
      options: ["explicit", "implicit"],
    });
    expect(() => scheme.set("magic" as never)).toThrow(/not one of/);
    expect(scheme.set("implicit" as never)).toBe("implicit");
  });

  it("supports updater functions through the same validation", () => {
    const steps = control({ name: "steps", value: 100, min: 1, max: 200 });
    expect(steps.set((n) => n * 3)).toBe(200); // computed, then clamped
  });
});

describe("dependency edges", () => {
  it("records control→cell and cell→cell reads from deps, refreshed per run", async () => {
    const kappa = control({ name: "kappa", value: 2 });
    const gate = control({ name: "useKappa", value: true });
    h = cellHarness(() => {
      const doubled = cell(
        () => ({ k: gate.get() ? kappa.get() : 0 }),
        async (d) => d.k * 2,
        { name: "doubled" },
      );
      const quadrupled = cell(
        () => ({ d: doubled() }),
        async (d) => d.d * 2,
        { name: "quadrupled" },
      );
      return { doubled, quadrupled };
    }) as CellHarness<object>;
    const cells = (h as CellHarness<{ doubled: unknown; quadrupled: unknown }>).cells;
    await whenReady(cells.quadrupled as never);

    const byCell = Object.fromEntries(dependencyEdges().map((e) => [e.cell, e.reads]));
    expect(byCell.doubled).toEqual([
      { kind: "control", name: "useKappa" },
      { kind: "control", name: "kappa" },
    ]);
    expect(byCell.quadrupled).toEqual([{ kind: "cell", name: "doubled" }]);

    // Close the gate: the next run stops reading kappa — the edge must drop.
    gate.set(false as never);
    await whenReady(cells.doubled as never);
    const after = Object.fromEntries(dependencyEdges().map((e) => [e.cell, e.reads]));
    expect(after.doubled).toEqual([{ kind: "control", name: "useKappa" }]);
  });

  it("drops a cell's edges when its owner is disposed", async () => {
    const kappa = control({ name: "kappa", value: 1 });
    const local = cellHarness(() => ({
      reader: cell(
        () => ({ k: kappa.get() }),
        async (d) => d.k,
        { name: "reader" },
      ),
    }));
    await whenReady(local.cells.reader);
    expect(dependencyEdges().map((e) => e.cell)).toContain("reader");
    local.dispose();
    expect(dependencyEdges().map((e) => e.cell)).not.toContain("reader");
  });
});

describe("the derived tools (registerStandardTools)", () => {
  it("report(brief) assembles controls/actions/cells/edges; full adds the metadata", async () => {
    const kappa = control({
      name: "kappa",
      value: 0.1,
      description: "Diffusion constant",
      min: 0.01,
      max: 1,
    });
    action({ name: "re-seed", description: "New noise seed", run: () => "seeded" });
    h = cellHarness(() => ({
      profile: cell(
        () => ({ k: kappa.get() }),
        async (d) => [d.k],
        {
          name: "profile",
          description: "The evolving profile",
        },
      ),
    })) as CellHarness<object>;
    await whenReady((h as CellHarness<{ profile: never }>).cells.profile);

    const kit = agentToolkit("ctlBrief");
    kit.registerReporter("custom", () => ({ mine: true }));
    registerStandardTools(kit);

    const brief = kit.handle().call("report") as Record<string, never>;
    expect(brief.controls).toEqual({ kappa: 0.1 });
    expect(brief.actions).toEqual(["re-seed"]);
    expect(brief.cells).toMatchObject({ profile: "ready" });
    expect(brief.edges).toEqual({ profile: ["control:kappa"] });
    expect(brief.custom).toEqual({ mine: true });

    const full = kit.handle().call("report", { format: "full" }) as Record<string, never>;
    expect(full.controls).toEqual([
      expect.objectContaining({
        name: "kappa",
        description: "Diffusion constant",
        meta: { min: 0.01, max: 1 },
      }),
    ]);
    expect(full.cells).toEqual([
      expect.objectContaining({ name: "profile", description: "The evolving profile" }),
    ]);
  });

  it("set validates through the control's own meta and returns what was written", () => {
    control({ name: "kappa", value: 0.1, min: 0.01, max: 1 });
    const kit = agentToolkit("ctlSet");
    registerStandardTools(kit);
    expect(kit.handle().call("set", { name: "kappa", value: 5 })).toEqual({
      name: "kappa",
      value: 1, // clamped by the SAME validation the widget path uses
    });
    expect(() => kit.handle().call("set", { name: "nope", value: 1 })).toThrow(/no control "nope"/);
  });

  it("every action is a real named tool — including ones declared later", () => {
    action({ name: "re-seed", description: "New noise seed", run: () => "seeded" });
    const kit = agentToolkit("ctlActs");
    registerStandardTools(kit);
    expect(kit.handle().call("re-seed")).toBe("seeded");

    // Declared AFTER registration: the surface subscription picks it up.
    action({
      name: "snapshot",
      description: "Capture the field",
      params: { label: "optional tag" },
      run: (args) => `snap:${String(args?.label ?? "")}`,
    });
    const tool = kit.handle().tools.find((t) => t.name === "snapshot");
    expect(tool?.description).toBe("Capture the field");
    expect(kit.handle().call("snapshot", { label: "t1" })).toBe("snap:t1");
  });

  it("an HMR re-declaration swaps the action's implementation behind the same tool", () => {
    action({ name: "re-seed", run: () => "old" });
    const kit = agentToolkit("ctlHmr");
    registerStandardTools(kit);
    action({ name: "re-seed", run: () => "new" }); // module re-evaluated
    expect(kit.handle().call("re-seed")).toBe("new"); // late-bound through the registry
  });
});
