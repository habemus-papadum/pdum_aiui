/**
 * spec.test.ts — the machine as tables, no host: §13.6's cells as rows.
 * The harness tests (client.test.ts) drive the full client; these pin the
 * pure reducer so a spec regression is caught without any wiring.
 */
import type { PageInstrumentation } from "@habemus-papadum/aiui-intent-runtime";
import type { AiuiGlobal } from "@habemus-papadum/aiui-viz";
import { createModeEngine, type EngineState } from "@habemus-papadum/aiui-viz/modal";
import { describe, expect, expectTypeOf, it } from "vitest";
import { initialContext, intentSpec } from "./spec";

/** The machine with a plausible world behind it: a channel to arm against (the
 * gate is enforced by `dispatch` itself, not merely greyed out in the bar) and
 * no frozen client holding the tab. These rows are about the MACHINE; the
 * world's gates have their own tests, in client.test.ts. */
const engine = (overrides: Record<string, string | boolean> = {}) =>
  createModeEngine(intentSpec, {
    context: { ...initialContext, connected: true },
    initial: overrides,
  });

/** One §13.6-style row: state × command → expected regions. */
const rows: Array<{
  name: string;
  start: Record<string, string | boolean>;
  command: string;
  expected: Partial<Record<string, string | boolean>>;
}> = [
  // (The invocation gesture has NO command row here on purpose: it is an
  // imperative event outside the modal system — activationGesture records the
  // capture grant only; its semantics are pinned in client.test.ts.)
  // arm column: one cap, status + toggle (gated on `connected` via available)
  {
    name: "arm from disarmed arms",
    start: {},
    command: "arm",
    expected: { phase: "armed" },
  },
  {
    name: "arm from armed disarms (full abandon, like d)",
    start: { phase: "armed", pencil: true },
    command: "arm",
    expected: { phase: "disarmed", pencil: false },
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
  // Enter column: send keeps armed
  {
    name: "send from turn keeps armed",
    start: { phase: "turn" },
    command: "send",
    expected: { phase: "armed" },
  },
  {
    name: "send while armed is nothing",
    start: { phase: "armed" },
    command: "send",
    expected: { phase: "armed" },
  },
  // (The T column is GONE — tweak died in C3': disarm is the escape hatch.)
  // Esc column: one level per press, the WHOLE ladder (armed → disarmed too)
  {
    name: "esc from turn cancels to armed",
    start: { phase: "turn" },
    command: "escape",
    expected: { phase: "armed" },
  },
  {
    name: "esc from armed steps out to the ONE hard disarmed (pencil clears)",
    start: { phase: "armed", pencil: true },
    command: "escape",
    expected: { phase: "disarmed", pencil: false },
  },
  {
    name: "esc dismisses help before the cancel rung",
    start: { phase: "turn", help: true },
    command: "escape",
    expected: { phase: "turn", help: false },
  },
  // d column — the hard-disarmed exclude does the clearing on EVERY route
  {
    name: "disarm clears pencil mode (the disarmed-is-hard invariant)",
    start: { phase: "turn", pencil: true },
    command: "disarm",
    expected: { phase: "disarmed", pencil: false },
  },
  {
    name: "the arm toggle from a turn reaches the same hard disarmed",
    start: { phase: "turn", pencil: true },
    command: "arm",
    expected: { phase: "disarmed", pencil: false },
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
    name: "hands-free STANDS across a send (C3': a standing mode; the window closes, the mode survives)",
    start: { phase: "turn", talk: "handsFree" },
    command: "send",
    expected: { phase: "armed", talk: "handsFree" },
  },
  {
    name: "h toggles hands-free while merely ARMED (C3': nothing records until a turn routes it)",
    start: { phase: "armed" },
    command: "handsFree",
    expected: { phase: "armed", talk: "handsFree" },
  },
  {
    name: "a send ends a HOLD window (its physical key lives in the turn grammar)",
    start: { phase: "turn", talk: "hold" },
    command: "send",
    expected: { phase: "armed", talk: "off" },
  },
  {
    name: "disarm ends hands-free (disarmed-is-hard widened in C3')",
    start: { phase: "turn", talk: "handsFree" },
    command: "disarm",
    expected: { phase: "disarmed", talk: "off", micMuted: false },
  },
  {
    name: "mute outside talk is nothing",
    start: { phase: "turn" },
    command: "mute",
    expected: { micMuted: false },
  },
  // The three page-pointer tools (pencil · area · jump) are MUTUALLY
  // EXCLUSIVE (owner, 2026-07-16): turning one ON clears the others. (Turning a
  // tool ON needs the world's gate — grant for area, __AIUI__ for jump — so
  // those rows live in client.test.ts; here the always-available commands
  // exercise the exclusion by clearing a seeded tool.)
  {
    name: "pencil turns off a live area (one page-pointer tool at a time)",
    start: { phase: "turn", region: true },
    command: "pencil",
    expected: { pencil: true, region: false, jump: false },
  },
  {
    name: "pencil turns off a live jump",
    start: { phase: "turn", jump: true },
    command: "pencil",
    expected: { pencil: true, jump: false },
  },
  {
    name: "area toggles OFF once on (always allowed — never stranded)",
    start: { phase: "turn", region: true },
    command: "region",
    expected: { region: false },
  },
  {
    name: "jump toggles OFF once on",
    start: { phase: "turn", jump: true },
    command: "jump",
    expected: { jump: false },
  },
  {
    name: "regionDone auto-exits area (a completed drag)",
    start: { phase: "turn", region: true },
    command: "regionDone",
    expected: { region: false },
  },
  {
    name: "jumpDone auto-exits jump (a committed/cancelled pick)",
    start: { phase: "turn", jump: true },
    command: "jumpDone",
    expected: { jump: false },
  },
  {
    name: "leaving the turn clears the area drag (area-needs-a-sink)",
    start: { phase: "turn", region: true },
    command: "send",
    expected: { phase: "armed", region: false },
  },
  // pause column (owner, 2026-07-30): an orthogonal toggle, only in a turn
  {
    name: "pause suspends collection in a turn",
    start: { phase: "turn" },
    command: "pause",
    expected: { phase: "turn", paused: true },
  },
  {
    name: "pause again resumes",
    start: { phase: "turn", paused: true },
    command: "pause",
    expected: { phase: "turn", paused: false },
  },
  {
    name: "pause outside a turn is nothing",
    start: { phase: "armed" },
    command: "pause",
    expected: { phase: "armed", paused: false },
  },
  {
    name: "send while paused still sends — and the exclude resets paused (pause-needs-turn)",
    start: { phase: "turn", paused: true },
    command: "send",
    expected: { phase: "armed", paused: false },
  },
  {
    name: "esc while paused cancels the turn (pause is not a rung)",
    start: { phase: "turn", paused: true },
    command: "escape",
    expected: { phase: "armed", paused: false },
  },
  {
    name: "pausing clears a live area drag (area-needs-a-sink — no sink, no crosshair)",
    start: { phase: "turn", region: true },
    command: "pause",
    expected: { phase: "turn", paused: true, region: false },
  },
  {
    name: "pausing ends a HOLD (hold-needs-a-sink — a gesture with no consumer is nothing)",
    start: { phase: "turn", talk: "hold" },
    command: "pause",
    expected: { phase: "turn", paused: true, talk: "off" },
  },
  {
    name: "pausing leaves the STANDING modes untouched (hands-free lit, video lit, pencil on)",
    start: { phase: "turn", talk: "handsFree", video: true, pencil: true },
    command: "pause",
    expected: { paused: true, talk: "handsFree", video: true, pencil: true },
  },
  {
    name: "space while paused is nothing (talkPress gates on the sink)",
    start: { phase: "turn", paused: true },
    command: "talkPress",
    expected: { talk: "off" },
  },
  {
    name: "mute still toggles while paused (the mode stands; mute is the source's)",
    start: { phase: "turn", paused: true, talk: "handsFree" },
    command: "mute",
    expected: { micMuted: true },
  },
  // oracle column (O3a, owner 2026-07-30): a standing armed-scope session that
  // TAKES THE SINK — which is what pauses an open turn, without touching the
  // manual `paused` region.
  {
    name: "oracle opens while merely armed (its own sink — nothing need be composing)",
    start: { phase: "armed" },
    command: "oracle",
    expected: { phase: "armed", oracle: true },
  },
  {
    name: "oracle from disarmed is nothing (arm first)",
    start: {},
    command: "oracle",
    expected: { phase: "disarmed", oracle: false },
  },
  {
    name: "oracle SURVIVES a send (standing, armed-scope like pencil)",
    start: { phase: "turn", oracle: true },
    command: "send",
    expected: { phase: "armed", oracle: true },
  },
  {
    name: "disarm closes the oracle (disarmed-is-hard — a live session must not outlive it)",
    start: { phase: "turn", oracle: true },
    command: "disarm",
    expected: { phase: "disarmed", oracle: false },
  },
  {
    name: "esc from a turn with the oracle on keeps the session (not a rung)",
    start: { phase: "turn", oracle: true },
    command: "escape",
    expected: { phase: "armed", oracle: true },
  },
  {
    name: "taking the oracle's sink clears a live area drag (area-needs-a-sink)",
    start: { phase: "turn", region: true },
    command: "oracle",
    expected: { oracle: true, region: false },
  },
  {
    name: "the oracle leaves the manual pause alone — a paused turn stays paused after it leaves",
    start: { phase: "turn", paused: true, oracle: true },
    command: "oracle",
    expected: { phase: "turn", oracle: false, paused: true },
  },
  {
    name: "park toggles while the oracle is live",
    start: { phase: "armed", oracle: true },
    command: "oraclePark",
    expected: { oracle: true, oracleParked: true },
  },
  {
    name: "park without a session is nothing",
    start: { phase: "armed" },
    command: "oraclePark",
    expected: { oracleParked: false },
  },
  {
    name: "closing the oracle un-parks it (park-needs-oracle)",
    start: { phase: "armed", oracle: true, oracleParked: true },
    command: "oracle",
    expected: { oracle: false, oracleParked: false },
  },
  {
    name: "park leaves the talk GRIP alone (independent of hands-free)",
    start: { phase: "armed", oracle: true, talk: "handsFree" },
    command: "oraclePark",
    expected: { oracleParked: true, talk: "handsFree" },
  },
  // cancelTurn column (owner, 2026-07-30): the explicit cancel cap's command
  {
    name: "cancelTurn abandons the turn back to armed",
    start: { phase: "turn" },
    command: "cancelTurn",
    expected: { phase: "armed" },
  },
  {
    name: "cancelTurn outside a turn is nothing",
    start: { phase: "armed" },
    command: "cancelTurn",
    expected: { phase: "armed" },
  },
  {
    name: "cancelTurn while paused resets paused with the exit",
    start: { phase: "turn", paused: true },
    command: "cancelTurn",
    expected: { phase: "armed", paused: false },
  },
  {
    name: "jump SURVIVES the turn (C3': an editor act, armed-scope like pencil)",
    start: { phase: "turn", jump: true },
    command: "send",
    expected: { phase: "armed", jump: true },
  },
  {
    name: "jump toggles OFF while merely ARMED (always escapable; the ON gate lives in available)",
    start: { phase: "armed", jump: true },
    command: "jump",
    expected: { phase: "armed", jump: false },
  },
  {
    name: "disarm clears a live jump too",
    start: { phase: "turn", jump: true },
    command: "disarm",
    expected: { phase: "disarmed", jump: false },
  },
  {
    name: "esc cancels the active area first, staying in the turn (escOrder)",
    start: { phase: "turn", region: true },
    command: "escape",
    expected: { phase: "turn", region: false },
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
    const e = engine({ phase: "turn", help: true, pencil: true, talk: "off" });
    let steps = 0;
    for (; steps < 10; steps++) {
      const before = e.state();
      if (e.dispatch("escape") === before) {
        break;
      }
    }
    expect(steps).toBeLessThanOrEqual(3); // help + turn→armed + armed→disarmed
    expect(e.state()).toMatchObject({ phase: "disarmed", help: false, pencil: false });
  });

  it("excludes hold after every command from a hostile seed", () => {
    const e = engine({ phase: "turn", talk: "handsFree", micMuted: true, help: true });
    for (const command of ["send", "turn", "handsFree", "disarm", "arm", "turn", "escape", "arm"]) {
      const s: EngineState = e.dispatch(command);
      // C3': hands-free STANDS outside a turn; only a HOLD needs one, and
      // disarm ends every talk mode (disarmed-is-hard).
      if (s.phase !== "turn") {
        expect(s.talk).not.toBe("hold");
      }
      if (s.phase === "disarmed") {
        expect(s.talk).toBe("off");
        expect(s.pencil).toBe(false); // one disarmed, and it is hard
      }
      if (s.talk === "off") {
        expect(s.micMuted).toBe(false);
      }
    }
  });

  it("hands-free stands across the whole armed session; only disarm ends it (C3')", () => {
    const e = engine({ phase: "armed" });
    expect(e.dispatch("handsFree")).toMatchObject({ phase: "armed", talk: "handsFree" });
    expect(e.dispatch("turn")).toMatchObject({ phase: "turn", talk: "handsFree" });
    expect(e.dispatch("send")).toMatchObject({ phase: "armed", talk: "handsFree" });
    expect(e.dispatch("escape")).toMatchObject({ phase: "disarmed", talk: "off" });
  });

  it("a paused turn refuses the contribution acts AT THE MACHINE (owner, 2026-07-30)", () => {
    // The world says yes to everything — grant on the tab in view, a live
    // selection — so the only gate left is the sink. Every route in (cap,
    // key, remote tap, agent write) meets `dispatch`'s refusal, not a dimmed
    // button.
    const e = createModeEngine(intentSpec, {
      context: {
        ...initialContext,
        connected: true,
        activeTab: 7,
        grantedTab: 7,
        selectionPresent: true,
      },
      initial: { phase: "turn" },
    });
    for (const command of ["shot", "selection", "region", "talkPress"]) {
      expect(e.canDispatch(command), `${command} in a live turn`).toBe(true);
    }
    e.dispatch("pause");
    for (const command of ["shot", "selection", "region", "talkPress"]) {
      expect(e.canDispatch(command), `${command} while paused`).toBe(false);
    }
    // The lifecycle stays live: pausing then sending what you have is the point.
    for (const command of ["send", "pause", "cancelTurn", "escape"]) {
      expect(e.canDispatch(command), `${command} while paused`).toBe(true);
    }
    e.dispatch("pause"); // resume
    for (const command of ["shot", "selection", "region", "talkPress"]) {
      expect(e.canDispatch(command), `${command} after resume`).toBe(true);
    }
  });

  it("the oracle TAKES the sink, so a turn's contributions are refused while it holds it (O3a)", () => {
    const e = createModeEngine(intentSpec, {
      context: {
        ...initialContext,
        connected: true,
        activeTab: 7,
        grantedTab: 7,
        selectionPresent: true,
        micGranted: true,
      },
      initial: { phase: "turn" },
    });
    expect(e.canDispatch("shot")).toBe(true);
    e.dispatch("oracle");
    // The PIXEL/selection acts refuse: their routing to the oracle is O3d, so
    // until then they must not land in the suspended turn behind it.
    for (const command of ["shot", "selection", "region"]) {
      expect(e.canDispatch(command), `${command} while the oracle holds the sink`).toBe(false);
    }
    // AUDIO is different — its routing IS wired in O3a: a hold goes to the
    // oracle, so push-to-talk stays live across the handover.
    expect(e.canDispatch("talkPress")).toBe(true);
    // …and the turn's own lifecycle stays live: you can still send what you had.
    expect(e.canDispatch("send")).toBe(true);
    e.dispatch("oracle"); // hand the sink back
    expect(e.canDispatch("shot")).toBe(true);
  });

  it("a HOLD survives the handover to the oracle and ends when no sink wants it", () => {
    const e = createModeEngine(intentSpec, {
      context: { ...initialContext, connected: true, micGranted: true },
      initial: { phase: "turn" },
    });
    e.dispatch("talkPress");
    expect(e.state().talk).toBe("hold");
    e.dispatch("oracle"); // the sink moves; the gesture keeps its consumer
    expect(e.state().talk).toBe("hold");
    e.dispatch("oracle"); // back to the turn, still holding
    expect(e.state().talk).toBe("hold");
    e.dispatch("pause"); // now nothing consumes it (hold-needs-a-sink)
    expect(e.state().talk).toBe("off");
  });

  it("a definitively REFUSED mic gates the oracle; never-asked does not (O3a)", () => {
    const refused = createModeEngine(intentSpec, {
      context: { ...initialContext, connected: true, micGranted: false },
      initial: { phase: "armed" },
    });
    expect(refused.canDispatch("oracle")).toBe(false);

    const unasked = createModeEngine(intentSpec, {
      context: { ...initialContext, connected: true },
      initial: { phase: "armed" },
    });
    expect(unasked.canDispatch("oracle")).toBe(true); // undefined = nobody asked yet

    const offline = createModeEngine(intentSpec, {
      context: { ...initialContext, connected: false, micGranted: true },
      initial: { phase: "armed" },
    });
    expect(offline.canDispatch("oracle")).toBe(false); // no channel to mint through

    // Turning a live session OFF is always allowed — never stranded, even
    // after the world's gates lapse.
    const stranded = createModeEngine(intentSpec, {
      context: { ...initialContext, connected: false, micGranted: false },
      initial: { phase: "armed", oracle: true },
    });
    expect(stranded.canDispatch("oracle")).toBe(true);
  });

  it("help is a standing root-level toggle (blank system: arm · step out · help)", () => {
    const e = engine();
    e.dispatch("help");
    expect(e.state().help).toBe(true); // no turn required
    expect(e.dispatch("escape").help).toBe(false); // esc still dismisses it first
  });

  it("esc unwinds the active page-tool BEFORE the phase ladder (escOrder), one press each", () => {
    const e = engine({ phase: "turn", region: true });
    // First press cancels the pick but keeps the turn (the old split-brain
    // stepped the phase AND cancelled the drag in one press).
    expect(e.dispatch("escape")).toMatchObject({ phase: "turn", region: false });
    // Only now does esc step the phase rung.
    expect(e.dispatch("escape")).toMatchObject({ phase: "armed" });
  });
});

// The `window.__AIUI__` global is declared twice: viz OWNS it (AiuiGlobal, with
// tools + the index signature) and the runtime READS it (PageInstrumentation).
// The client prod-deps both, the one point on the graph that sees each — so a
// `v` bump or a `sourceRoot` retype on either side must break the build here.
// See docs/proposals/code-review-pass2-s1-mirrors.md.
describe("__AIUI__ global: viz's AiuiGlobal stays assignable to the runtime's reader view", () => {
  it("AiuiGlobal satisfies PageInstrumentation (compile-time)", () => {
    expectTypeOf<AiuiGlobal>().toMatchTypeOf<PageInstrumentation>();
  });
});
