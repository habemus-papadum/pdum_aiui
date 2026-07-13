/**
 * engine.test.ts — spec-first tests for the mode engine kernel
 * (docs/proposals/intent-client/01-mode-engine.md §5): table tests for the
 * reducer, property tests for esc/blur/excludes, commit/queue semantics.
 *
 * The test spec is a miniature of the intent panel's real shape (phase
 * ladder with an esc floor, standing toggles, a talk choice, transient
 * help/leader, a blur-exiting picker ladder) so the rows read like §13.6.
 */
import { describe, expect, it } from "vitest";
import {
  choice,
  createModeEngine,
  type DispatchEvent,
  ladder,
  type ModeEngineSpec,
  toggle,
} from "./engine";

interface Ctx {
  grantedTab: number | undefined;
}

const spec: ModeEngineSpec<Ctx> = {
  regions: {
    phase: ladder(["disarmed", "armed", "turn", "tweak"], { escFloor: "armed" }),
    ink: toggle({ durable: true }),
    video: toggle(),
    talk: choice(["off", "dictation", "handsFree", "realtime"]),
    help: toggle({ blurExits: true }),
    leader: toggle({ blurExits: true }),
    jump: ladder(["off", "picker"], { blurExitsFrom: ["picker"] }),
  },
  commands: {
    arm: (s) => (s.phase === "disarmed" ? { phase: "armed" } : null),
    openTurn: (s) => (s.phase === "armed" ? { phase: "turn" } : null),
    tweak: (s) => (s.phase === "turn" ? { phase: "tweak" } : null),
    disarm: () => ({
      phase: "disarmed",
      ink: false,
      video: false,
      talk: "off",
      help: false,
      leader: false,
    }),
    ink: (s) => ({ ink: !(s.ink as boolean) }),
    talkTo: (_s, payload) => ({ talk: payload as string }),
    toggleHelp: (s) => ({ help: !(s.help as boolean) }),
    openPicker: () => ({ jump: "picker" }),
    // A command that needs the context (grant-gated) — facts, not choices.
    grantTurn: (s, _p, ctx) =>
      s.phase === "armed" && ctx.grantedTab !== undefined ? { phase: "turn" } : null,
  },
  escOrder: ["help", "leader", "jump", "phase"],
  excludes: [
    // invariant: nothing talks while disarmed, whoever moved the state
    { name: "talk-requires-armed", when: (s) => s.phase === "disarmed", set: { talk: "off" } },
    // invariant: realtime claims the whole audio path — video off
    { name: "realtime-excludes-video", when: (s) => s.talk === "realtime", set: { video: false } },
  ],
  on: {
    turnClosed: "escapeTurn",
  },
};

// turnClosed binding target — declared separately so the spec above stays readable
const fullSpec: ModeEngineSpec<Ctx> = {
  ...spec,
  commands: {
    ...spec.commands,
    escapeTurn: (s) => (s.phase === "turn" || s.phase === "tweak" ? { phase: "armed" } : null),
  },
};

const engine = (initial?: Record<string, string | boolean>) =>
  createModeEngine(fullSpec, {
    context: { grantedTab: undefined },
    ...(initial !== undefined ? { initial } : {}),
  });

describe("dispatch: the reducer table", () => {
  it("commands move regions through validated patches", () => {
    const e = engine();
    expect(e.state().phase).toBe("disarmed");
    e.dispatch("arm");
    expect(e.state().phase).toBe("armed");
    e.dispatch("openTurn");
    e.dispatch("ink");
    expect(e.state()).toMatchObject({ phase: "turn", ink: true });
  });

  it("reads of state() are NEVER stale — plain object, same tick, any scope", () => {
    const e = engine();
    e.dispatch("arm");
    // The whole write-then-read-back trap has no surface here: machine truth
    // is a frozen plain object, not a staged signal.
    expect(e.state().phase).toBe("armed");
  });

  it("a guarded command that does not apply is a clean no-op", () => {
    const e = engine();
    expect(e.dispatch("openTurn").phase).toBe("disarmed"); // needs armed
  });

  it("payloads flow through (talkTo) and are validated against the region", () => {
    const e = engine();
    e.dispatch("arm");
    e.dispatch("talkTo", "dictation");
    expect(e.state().talk).toBe("dictation");
    expect(() => e.dispatch("talkTo", "yodeling")).toThrow(/allows "off"/);
  });

  it("context participates in reductions but is never a region", () => {
    const e = engine();
    e.dispatch("arm");
    expect(e.dispatch("grantTurn").phase).toBe("armed"); // no grant yet
    e.setContext({ grantedTab: 42 });
    expect(e.dispatch("grantTurn").phase).toBe("turn");
  });

  it("set:<region> is built in — the agent bridge and caps share it", () => {
    const e = engine();
    e.dispatch("set:video", true);
    expect(e.state().video).toBe(true);
    expect(() => e.dispatch("set:video", "sideways")).toThrow(/is a toggle/);
    expect(() => e.dispatch("set:nope", 1)).toThrow(/unknown region/);
  });

  it("unknown commands throw loudly (commands are code, not input)", () => {
    expect(() => engine().dispatch("frobnicate")).toThrow(/unknown command/);
  });
});

describe("excludes: invariants applied after every command, in order", () => {
  it("holds the invariant no matter which command moved the state", () => {
    const e = engine();
    e.dispatch("arm");
    e.dispatch("talkTo", "dictation");
    e.dispatch("disarm");
    expect(e.state().talk).toBe("off"); // the exclude, not the command, guarantees it
  });

  it("applies in declaration order, once, no fixpoint", () => {
    const e = engine();
    e.dispatch("arm");
    e.dispatch("set:video", true);
    e.dispatch("talkTo", "realtime");
    expect(e.state().video).toBe(false); // realtime forces video off
  });

  it("property: every excludes invariant holds after every command", () => {
    const commands: Array<[string, unknown?]> = [
      ["arm"],
      ["openTurn"],
      ["ink"],
      ["set:video", true],
      ["talkTo", "realtime"],
      ["tweak"],
      ["toggleHelp"],
      ["disarm"],
      ["arm"],
      ["talkTo", "handsFree"],
      ["escape"],
      ["blur"],
    ];
    const e = engine();
    for (const [command, payload] of commands) {
      const state = e.dispatch(command, payload);
      for (const rule of fullSpec.excludes ?? []) {
        if (rule.when(state)) {
          for (const [region, value] of Object.entries(rule.set)) {
            expect(state[region], `${rule.name} after ${command}`).toBe(value);
          }
        }
      }
    }
  });
});

describe("escape: the ladder as a list", () => {
  it("steps the highest-ranked non-base region out one level per press", () => {
    const e = engine();
    e.dispatch("arm");
    e.dispatch("openTurn");
    e.dispatch("tweak");
    e.dispatch("toggleHelp");
    expect(e.dispatch("escape")).toMatchObject({ help: false, phase: "tweak" }); // help first
    expect(e.dispatch("escape").phase).toBe("turn"); // then the ladder, one rung
    expect(e.dispatch("escape").phase).toBe("armed"); // turn-cancel
  });

  it("never steps a ladder below its escFloor — Esc is not disarm", () => {
    const e = engine();
    e.dispatch("arm");
    const before = e.state();
    expect(e.dispatch("escape")).toBe(before); // no-op: armed is the floor
  });

  it("property: Esc from any reachable state reaches quiescence in ≤ total depth steps", () => {
    const seed: Array<[string, unknown?]> = [
      ["arm"],
      ["openTurn"],
      ["tweak"],
      ["ink"],
      ["toggleHelp"],
      ["openPicker"],
      ["talkTo", "handsFree"],
    ];
    const e = engine();
    for (const [command, payload] of seed) {
      e.dispatch(command, payload);
    }
    // total esc depth: help(1) + leader(1) + jump(1) + phase(tweak→armed = 2)
    const bound = 5;
    let steps = 0;
    for (; steps <= bound; steps++) {
      const before = e.state();
      if (e.dispatch("escape") === before) {
        break;
      }
    }
    expect(steps).toBeLessThanOrEqual(bound);
    // quiescent = every esc-order region at its base (phase at its floor)
    expect(e.state()).toMatchObject({ help: false, leader: false, jump: "off", phase: "armed" });
  });
});

describe("blur: the page-focus sibling of Esc", () => {
  it("exits every blurExits region in one dispatch, one ladder step for opted rungs", () => {
    const e = engine();
    e.dispatch("arm");
    e.dispatch("toggleHelp");
    e.dispatch("openPicker");
    const after = e.dispatch("blur");
    expect(after).toMatchObject({ help: false, jump: "off" });
  });

  it("property: blur never exits a non-blurExits region", () => {
    const e = engine();
    e.dispatch("arm");
    e.dispatch("openTurn");
    e.dispatch("ink");
    e.dispatch("talkTo", "dictation");
    const after = e.dispatch("blur");
    expect(after).toMatchObject({ phase: "turn", ink: true, talk: "dictation" });
  });
});

describe("bindings: system events funnel into the same dispatch", () => {
  it("emit routes a declared event to its command", () => {
    const e = engine();
    e.dispatch("arm");
    e.dispatch("openTurn");
    expect(e.emit("turnClosed").phase).toBe("armed");
  });

  it("unbound events are ignored", () => {
    const e = engine();
    const before = e.state();
    expect(e.emit("cosmicRay")).toBe(before);
  });
});

describe("commit and trace", () => {
  it("notifies subscribers inside the commit hook with the event", () => {
    const order: string[] = [];
    const e = createModeEngine(fullSpec, {
      context: { grantedTab: undefined },
      commit: (apply) => {
        order.push("commit-start");
        apply();
        order.push("commit-end");
      },
    });
    e.subscribe((state, event) => {
      order.push(`notified:${event.kind === "dispatch" ? event.command : "context"}`);
      expect(state.phase).toBe("armed"); // state already advanced when notified
    });
    e.dispatch("arm");
    expect(order).toEqual(["commit-start", "notified:arm", "commit-end"]);
  });

  it("a dispatch from inside a subscriber queues until the commit completes", () => {
    const e = engine();
    const phases: string[] = [];
    const unsubscribe = e.subscribe((state, event) => {
      phases.push(String(state.phase));
      if (event.kind === "dispatch" && event.command === "arm") {
        e.dispatch("openTurn"); // must not interleave with the arm commit
      }
    });
    e.dispatch("arm");
    unsubscribe();
    expect(phases).toEqual(["armed", "turn"]); // linear: arm committed, then openTurn
    expect(e.state().phase).toBe("turn");
  });

  it("every dispatch is a trace event — including resolved no-ops", () => {
    const events: DispatchEvent[] = [];
    const e = createModeEngine(fullSpec, {
      context: { grantedTab: undefined },
      onDispatch: (event) => events.push(event),
    });
    e.dispatch("arm");
    e.dispatch("escape"); // no-op at the floor
    expect(events.map((ev) => [ev.command, ev.changed])).toEqual([
      ["arm", ["phase"]],
      ["escape", []],
    ]);
  });
});

describe("canDispatch: availability is derived from the reducer", () => {
  it("dry-runs the pure reducer — guarded commands read as unavailable", () => {
    const e = engine();
    expect(e.canDispatch("arm")).toBe(true);
    expect(e.canDispatch("openTurn")).toBe(false); // needs armed
    expect(e.canDispatch("tweak")).toBe(false);
    e.dispatch("arm");
    expect(e.canDispatch("openTurn")).toBe(true);
    expect(e.canDispatch("arm")).toBe(false); // already armed — nothing to do
  });

  it("a patch that changes nothing counts as unavailable", () => {
    const e = engine({ phase: "armed" });
    // grantTurn returns null without a grant; with one, it patches phase.
    expect(e.canDispatch("grantTurn")).toBe(false);
    e.setContext({ grantedTab: 3 });
    expect(e.canDispatch("grantTurn")).toBe(true);
  });

  it("escape/blur resolve their own steps", () => {
    const e = engine();
    expect(e.canDispatch("escape")).toBe(false); // everything at base
    e.dispatch("arm");
    e.dispatch("openTurn");
    expect(e.canDispatch("escape")).toBe(true);
    expect(e.canDispatch("blur")).toBe(false); // nothing blur-exiting is up
    e.dispatch("toggleHelp");
    expect(e.canDispatch("blur")).toBe(true);
  });

  it("spec.available overrides derivation (verbs; context gates)", () => {
    const e = createModeEngine(
      {
        ...fullSpec,
        available: {
          arm: (_s, ctx) => ctx.grantedTab !== undefined, // context-gated arm
        },
      },
      { context: { grantedTab: undefined } },
    );
    expect(e.canDispatch("arm")).toBe(false);
    e.setContext({ grantedTab: 1 });
    expect(e.canDispatch("arm")).toBe(true);
  });

  it("REFUSES an unavailable command — the gate is the machine's, not the bar's", () => {
    // A bar button can be greyed out; a key, an agent's control() write and a
    // recovered turn cannot. They all arrive as the same dispatch, so a gate
    // enforced only where the buttons live is a gate that holds until the first
    // other caller (found in Phase 4: the coexistence rule was bypassable by
    // simply pressing the key).
    const e = createModeEngine(
      {
        ...fullSpec,
        available: { arm: (_s, ctx) => ctx.grantedTab !== undefined },
      },
      { context: { grantedTab: undefined } },
    );
    expect(e.dispatch("arm")).toEqual(e.state()); // refused: nothing moved
    expect(e.state().phase).toBe("disarmed");

    e.setContext({ grantedTab: 1 });
    e.dispatch("arm");
    expect(e.state().phase).toBe("armed");
  });

  it("throws on unknown commands and validates available keys at creation", () => {
    expect(() => engine().canDispatch("frobnicate")).toThrow(/unknown command/);
    expect(() =>
      createModeEngine(
        { regions: { x: toggle() }, commands: {}, available: { ghost: () => true } },
        { context: {} },
      ),
    ).toThrow(/available names unknown command/);
  });
});

describe("spec validation at creation", () => {
  it("rejects initial overrides for unknown regions or illegal values", () => {
    expect(() => engine({ nope: true })).toThrow(/unknown region/);
    expect(() => engine({ phase: "levitating" })).toThrow(/allows/);
  });

  it("adopts valid initial overrides (durable recovery)", () => {
    const e = engine({ phase: "armed", ink: true });
    expect(e.state()).toMatchObject({ phase: "armed", ink: true });
  });

  it("rejects specs that shadow built-ins", () => {
    expect(() =>
      createModeEngine(
        {
          regions: { x: toggle() },
          commands: { escape: () => null },
        },
        { context: {} },
      ),
    ).toThrow(/built-in/);
  });
});

describe("state immutability", () => {
  it("states are frozen snapshots — history stays trustworthy", () => {
    const e = engine();
    const before = e.state();
    e.dispatch("arm");
    expect(before.phase).toBe("disarmed");
    expect(Object.isFrozen(before)).toBe(true);
    expect(Object.isFrozen(e.state())).toBe(true);
  });
});
