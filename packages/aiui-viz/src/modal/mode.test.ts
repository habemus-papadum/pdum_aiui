// @vitest-environment node
import { describe, expect, it } from "vitest";
import { escTarget, type ModeTable, runTransition } from "./mode";

// The overlay's ladder shape in miniature: idle → armed → ink. Effects log
// into an array so ordering (exit before enter) is observable.
type M = "idle" | "armed" | "ink";

function makeTable(log: string[]): ModeTable<M> {
  return {
    initial: "idle",
    modes: {
      idle: { escParent: null },
      armed: {
        escParent: "idle",
        cursor: "crosshair",
        onEnter: (from) => log.push(`armed.enter(from ${from})`),
        onExit: (to) => log.push(`armed.exit(to ${to})`),
      },
      ink: {
        escParent: "armed",
        onEnter: (from) => log.push(`ink.enter(from ${from})`),
        onExit: (to) => log.push(`ink.exit(to ${to})`),
      },
    },
  };
}

describe("escTarget", () => {
  it("reads the Esc ladder as a column: ink steps to armed, armed to idle, idle nowhere", () => {
    const table = makeTable([]);
    expect(escTarget(table, "ink")).toBe("armed");
    expect(escTarget(table, "armed")).toBe("idle");
    expect(escTarget(table, "idle")).toBeNull(); // the root: Esc means nothing here
  });
});

describe("runTransition", () => {
  it("fires the old mode's exit, then the new mode's enter, and returns the target", () => {
    const log: string[] = [];
    const table = makeTable(log);
    expect(runTransition(table, "armed", "ink")).toBe("ink");
    expect(log).toEqual(["armed.exit(to ink)", "ink.enter(from armed)"]);
  });

  it("hands each effect the far side of the transition", () => {
    const log: string[] = [];
    const table = makeTable(log);
    runTransition(table, "ink", "armed"); // stepping OUT along the ladder
    expect(log).toEqual(["ink.exit(to armed)", "armed.enter(from ink)"]);
  });

  it("a self-transition runs no effects at all", () => {
    const log: string[] = [];
    const table = makeTable(log);
    expect(runTransition(table, "armed", "armed")).toBe("armed");
    expect(log).toEqual([]);
  });

  it("modes without effects transition silently — onEnter/onExit are optional", () => {
    const log: string[] = [];
    const table = makeTable(log);
    expect(runTransition(table, "idle", "armed")).toBe("armed"); // idle has no onExit
    expect(log).toEqual(["armed.enter(from idle)"]);
  });
});
