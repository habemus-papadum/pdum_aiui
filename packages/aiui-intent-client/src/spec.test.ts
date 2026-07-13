/**
 * spec.test.ts — the machine as tables, no host: §13.6's cells as rows.
 * The harness tests (client.test.ts) drive the full client; these pin the
 * pure reducer so a spec regression is caught without any wiring.
 */
import { createModeEngine, type EngineState } from "@habemus-papadum/aiui-viz/modal";
import { describe, expect, it } from "vitest";
import { initialContext, intentSpec } from "./spec";

const engine = (overrides: Partial<Record<string, string | boolean>> = {}) =>
  createModeEngine(intentSpec, { context: initialContext, initial: overrides });

/** One §13.6-style row: state × command → expected regions. */
const rows: Array<{
  name: string;
  start: Partial<Record<string, string | boolean>>;
  command: string;
  expected: Partial<Record<string, string | boolean>>;
}> = [
  // ⌘B column: grant-and-open, idempotent, resumes tweak
  {
    name: "⌘B from disarmed opens a turn",
    start: {},
    command: "cmdB",
    expected: { phase: "turn" },
  },
  {
    name: "⌘B from armed opens a turn",
    start: { phase: "armed" },
    command: "cmdB",
    expected: { phase: "turn" },
  },
  {
    name: "⌘B in a turn is a no-op",
    start: { phase: "turn" },
    command: "cmdB",
    expected: { phase: "turn" },
  },
  {
    name: "⌘B resumes from tweak",
    start: { phase: "tweak" },
    command: "cmdB",
    expected: { phase: "turn" },
  },
  // arm column: one cap, status + toggle (gated on `connected` via available)
  {
    name: "arm from disarmed arms",
    start: {},
    command: "arm",
    expected: { phase: "armed" },
  },
  {
    name: "arm from armed disarms (full abandon, like d)",
    start: { phase: "armed", ink: true },
    command: "arm",
    expected: { phase: "disarmed", ink: false },
  },
  {
    name: "arm mid-turn abandons the turn",
    start: { phase: "turn", talk: "handsFree" },
    command: "arm",
    expected: { phase: "disarmed", talk: "off" },
  },
  // turn column: the bar's open-turn (⌘B minus the mint)
  {
    name: "turn opens from armed",
    start: { phase: "armed" },
    command: "turn",
    expected: { phase: "turn" },
  },
  {
    name: "turn from disarmed is nothing (arm first)",
    start: {},
    command: "turn",
    expected: { phase: "disarmed" },
  },
  // Enter column: send keeps armed, from tweak too
  {
    name: "send from turn keeps armed",
    start: { phase: "turn" },
    command: "send",
    expected: { phase: "armed" },
  },
  {
    name: "send from tweak keeps armed",
    start: { phase: "tweak" },
    command: "send",
    expected: { phase: "armed" },
  },
  {
    name: "send while armed is nothing",
    start: { phase: "armed" },
    command: "send",
    expected: { phase: "armed" },
  },
  // T column
  {
    name: "tweak from turn",
    start: { phase: "turn" },
    command: "tweak",
    expected: { phase: "tweak" },
  },
  {
    name: "tweak from tweak releases back to turn (the panel cap; T on the page passes through)",
    start: { phase: "tweak" },
    command: "tweak",
    expected: { phase: "turn" },
  },
  {
    name: "tweak outside turn is nothing",
    start: { phase: "armed" },
    command: "tweak",
    expected: { phase: "armed" },
  },
  // Esc column: one level, floor at armed
  {
    name: "esc from tweak returns to turn",
    start: { phase: "tweak" },
    command: "escape",
    expected: { phase: "turn" },
  },
  {
    name: "esc from turn cancels to armed",
    start: { phase: "turn" },
    command: "escape",
    expected: { phase: "armed" },
  },
  {
    name: "esc from armed does nothing",
    start: { phase: "armed" },
    command: "escape",
    expected: { phase: "armed" },
  },
  {
    name: "esc dismisses help before the cancel rung",
    start: { phase: "turn", help: true },
    command: "escape",
    expected: { phase: "turn", help: false },
  },
  // d column
  {
    name: "disarm clears ink mode (nothing else does)",
    start: { phase: "turn", ink: true },
    command: "disarm",
    expected: { phase: "disarmed", ink: false },
  },
  {
    name: "disarm leaves standing video settings alone",
    start: { phase: "turn", video: true, videoMode: "constant" },
    command: "disarm",
    expected: { video: true, videoMode: "constant" },
  },
  // talk columns
  {
    name: "space opens a hold window, unmuted",
    start: { phase: "turn", micMuted: false },
    command: "talkPress",
    expected: { talk: "hold", micMuted: false },
  },
  {
    name: "space during hands-free is nothing",
    start: { phase: "turn", talk: "handsFree" },
    command: "talkPress",
    expected: { talk: "handsFree" },
  },
  {
    name: "space-up ends only a hold",
    start: { phase: "turn", talk: "handsFree" },
    command: "talkRelease",
    expected: { talk: "handsFree" },
  },
  {
    name: "h toggles hands-free",
    start: { phase: "turn" },
    command: "handsFree",
    expected: { talk: "handsFree" },
  },
  {
    name: "tweak ends the talk window (talk is per-turn)",
    start: { phase: "turn", talk: "handsFree" },
    command: "tweak",
    expected: { phase: "tweak", talk: "off" },
  },
  {
    name: "mute outside talk is nothing",
    start: { phase: "turn" },
    command: "mute",
    expected: { micMuted: false },
  },
];

describe("the §13.6 tables", () => {
  for (const row of rows) {
    it(row.name, () => {
      const e = engine(row.start);
      const after = e.dispatch(row.command);
      expect(after).toMatchObject(row.expected);
    });
  }
});

describe("spec-level properties", () => {
  it("esc terminates at quiescence from the deepest state", () => {
    const e = engine({ phase: "tweak", help: true, ink: true, talk: "off" });
    let steps = 0;
    for (; steps < 10; steps++) {
      const before = e.state();
      if (e.dispatch("escape") === before) {
        break;
      }
    }
    expect(steps).toBeLessThanOrEqual(3); // help + tweak→turn + turn→armed
    expect(e.state()).toMatchObject({ phase: "armed", help: false });
  });

  it("excludes hold after every command from a hostile seed", () => {
    const e = engine({ phase: "turn", talk: "handsFree", micMuted: true, help: true });
    for (const command of ["send", "cmdB", "handsFree", "disarm", "cmdB", "escape", "arm"]) {
      const s: EngineState = e.dispatch(command);
      if (s.phase !== "turn") {
        expect(s.talk).toBe("off");
      }
      if (s.talk === "off") {
        expect(s.micMuted).toBe(false);
      }
    }
  });

  it("help is a standing root-level toggle (blank system: arm · step out · help)", () => {
    const e = engine();
    e.dispatch("help");
    expect(e.state().help).toBe(true); // no turn required
    expect(e.dispatch("escape").help).toBe(false); // esc still dismisses it first
  });
});
