// @vitest-environment jsdom
/**
 * mode-solid.test.ts — the Solid adapter: flush()-committed dispatch (state,
 * memos, and effect-driven projections all current when dispatch returns),
 * the agent bridge (control.set IS a dispatch — single writer), claims wired
 * to commits, durable adoption across engine rebuilds.
 */
import { createEffect, createMemo, createRoot } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearControlSurface, controlByName } from "./control";
import { disposeDurable } from "./durable";
import { choice, type EngineState, ladder, type ModeEngineSpec, toggle } from "./modal";
import { solidModeEngine } from "./mode-solid";

interface Ctx {
  tab: number | undefined;
}

const spec: ModeEngineSpec<Ctx> = {
  regions: {
    phase: ladder(["disarmed", "armed", "turn"], { escFloor: "armed" }),
    ink: toggle({ durable: true }),
    video: toggle({ agent: "videoOn", durable: true, description: "sample tab frames" }),
    videoMode: choice(["smart", "constant"], { agent: "videoMode" }),
  },
  commands: {
    arm: () => ({ phase: "armed" }),
    openTurn: (s) => (s.phase === "armed" ? { phase: "turn" } : null),
    ink: (s) => ({ ink: !(s.ink as boolean) }),
  },
  escOrder: ["phase"],
};

function hardReset(): void {
  const { durableKeys } = clearControlSurface();
  for (const key of durableKeys) {
    disposeDurable(key);
  }
  for (const region of Object.keys(spec.regions)) {
    disposeDurable(`mode:${region}`);
  }
}
afterEach(() => {
  hardReset();
  vi.restoreAllMocks();
});

describe("flush()-committed dispatch", () => {
  it("memos AND effect-driven projections are current when dispatch returns", async () => {
    const engine = solidModeEngine({ spec, context: { tab: undefined } });
    let painted = "";
    const { label, dispose } = createRoot((dispose) => {
      const label = createMemo(() => (engine.state().ink ? "lit" : "off"));
      createEffect(
        () => label(),
        (v) => {
          painted = v;
        },
      );
      return { label, dispose };
    });
    await Promise.resolve(); // settle initial effects
    expect(painted).toBe("off");

    engine.dispatch("ink"); // an imperative boundary — a key handler
    // No await, no flush() at the call site: the engine committed for us.
    expect(engine.state().ink).toBe(true);
    expect(label()).toBe("lit"); // derived read: FRESH
    expect(painted).toBe("lit"); // effect-driven projection: ALREADY PAINTED
    dispose();
    await engine.dispose();
  });
});

describe("the agent bridge", () => {
  it("control.set dispatches — agent writes and key writes take the identical path", async () => {
    const trace: string[] = [];
    const engine = solidModeEngine({
      spec,
      context: { tab: undefined },
      onDispatch: (event) => trace.push(event.command),
    });
    const videoOn = controlByName("videoOn");
    expect(videoOn).toBeDefined();

    const written = videoOn?.set(true as never);
    expect(written).toBe(true); // the post-reducer truth, returned
    expect(engine.state().video).toBe(true); // the region moved
    expect(videoOn?.get()).toBe(true); // the control followed
    expect(trace).toContain("set:video"); // one path: a dispatch
    await engine.dispose();
  });

  it("a dispatch moves the control too — no mirror to forget", async () => {
    const engine = solidModeEngine({ spec, context: { tab: undefined } });
    engine.dispatch("set:video", true);
    expect(controlByName("videoOn")?.get()).toBe(true);
    await engine.dispose();
  });

  it("choice regions expose their values as control options", async () => {
    const engine = solidModeEngine({ spec, context: { tab: undefined } });
    const videoMode = controlByName("videoMode");
    expect(videoMode?.meta.options).toEqual(["smart", "constant"]);
    // The bridged setter dispatches, so the ENGINE validates — one validator,
    // one error, whoever writes.
    expect(() => videoMode?.set("sideways" as never)).toThrow(/allows "smart"/);
    await engine.dispose();
  });
});

describe("claims wiring", () => {
  it("reconciles after every commit; statuses are a reactive view", async () => {
    const acquired: number[] = [];
    const engine = solidModeEngine<Ctx>({
      spec,
      context: { tab: undefined },
      claims: {
        tabStream: {
          derive: (s: EngineState, ctx: Ctx) =>
            s.phase === "turn" && ctx.tab !== undefined ? { tab: ctx.tab } : null,
          acquire: async (desire: { tab: number }) => {
            acquired.push(desire.tab);
            return `stream@${desire.tab}`;
          },
        },
      },
    });
    engine.dispatch("arm");
    engine.setContext({ tab: 42 });
    engine.dispatch("openTurn");
    for (let i = 0; i < 12; i++) {
      await Promise.resolve(); // the claim chain settles over several microtasks
    }
    expect(acquired).toEqual([42]);
    expect(engine.claimStatuses().tabStream).toMatchObject({ phase: "active" });
    await engine.dispose();
  });
});

describe("durable adoption", () => {
  it("a rebuilt engine (hot edit) adopts durable regions — agent and plain alike", async () => {
    const first = solidModeEngine({ spec, context: { tab: undefined } });
    first.dispatch("ink"); // durable non-agent region
    first.dispatch("set:video", true); // durable agent region
    await first.dispose();

    // The module re-evaluates: same spec, fresh engine, same window.
    const second = solidModeEngine({ spec, context: { tab: undefined } });
    expect(second.state().ink).toBe(true);
    expect(second.state().video).toBe(true);
    await second.dispose();
  });
});
