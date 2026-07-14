// @vitest-environment jsdom
/**
 * solid.test.tsx — the host binding as a projection: drive a real
 * `solidModeEngine` and assert the bar it puts on the wire. Uses the actual
 * engine (not a fake) so the flush()-committed republish path — the one the
 * intent client relies on — is what gets tested.
 */
import { solidModeEngine } from "@habemus-papadum/aiui-viz";
import {
  barModel,
  type CapSpec,
  type EngineState,
  ladder,
  type ModeEngineSpec,
  toggle,
} from "@habemus-papadum/aiui-viz/modal";
import { afterEach, describe, expect, it } from "vitest";
import type { HostToRelay } from "./protocol";
import { type BarSource, bindRemoteBar } from "./solid";

interface Ctx {
  ready: boolean;
}

const spec: ModeEngineSpec<Ctx> = {
  regions: {
    phase: ladder(["disarmed", "armed"], { escFloor: "disarmed" }),
    ink: toggle(),
  },
  commands: {
    arm: () => ({ phase: "armed" }),
    ink: (s) => ({ ink: !(s.ink as boolean) }),
    // The evolved barModel derives enablement through canDispatch — every cap's
    // command must exist in the spec or the projection effect dies quietly.
    danger: (s) => s,
  },
  escOrder: ["phase"],
};

const caps: CapSpec<Ctx>[] = [
  { command: "ink", hint: { key: "i", label: "ink" }, litWhen: ({ state }) => state.ink === true },
  { command: "danger", hint: { key: "d", label: "danger", tone: "danger" } },
];

const settle = async (rounds = 6): Promise<void> => {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
};

let teardown: (() => Promise<void>) | undefined;
afterEach(async () => {
  await teardown?.();
  teardown = undefined;
});

function harness(filter?: (cap: { command: string }) => boolean) {
  const engine = solidModeEngine<Ctx>({ spec, context: { ready: true } });
  const source: BarSource = {
    bar: () =>
      barModel(caps, {
        state: engine.state(),
        ctx: engine.context(),
        claims: engine.claimStatuses(),
        canDispatch: engine.canDispatch,
      }),
    claimStatuses: () => engine.claimStatuses(),
    state: () => engine.state() as EngineState & { phase?: unknown },
    dispatch: engine.dispatch,
  };
  const sent: HostToRelay[] = [];
  const bound = bindRemoteBar(source, {
    send: (m) => sent.push(m),
    ...(filter ? { filter } : {}),
  });
  teardown = async () => {
    bound.dispose();
    await engine.dispose();
  };
  const lastBar = () =>
    sent.filter((m) => m.type === "bar").at(-1) as
      | Extract<HostToRelay, { type: "bar" }>
      | undefined;
  return { engine, bound, sent, lastBar };
}

describe("bindRemoteBar", () => {
  it("publishes an initial bar on creation, so an idle host still has one to replay", async () => {
    const h = harness();
    await settle();
    const bar = h.lastBar();
    expect(bar).toBeDefined();
    expect(bar?.phase).toBe("disarmed");
    expect(bar?.rows.map((r) => r.command)).toEqual(["ink", "danger"]);
  });

  it("republishes on every commit — a dispatch lights its cap in the same breath", async () => {
    const h = harness();
    await settle();
    const before = h.sent.length;

    h.engine.dispatch("ink"); // flush-committed: the effect republishes synchronously
    expect(h.sent.length).toBeGreaterThan(before);
    const ink = h.lastBar()?.rows.find((r) => r.command === "ink");
    expect(ink?.lit).toBe(true);

    h.engine.dispatch("arm");
    expect(h.lastBar()?.phase).toBe("armed");
  });

  it("threads the app-level filter — a rejected cap never reaches the wire (D5 subset)", async () => {
    const h = harness((cap) => cap.command !== "danger");
    await settle();
    expect(h.lastBar()?.rows.map((r) => r.command)).toEqual(["ink"]);
  });

  it("routes an inbound remote command into the engine (single writer)", async () => {
    const h = harness();
    await settle();
    // A remote tap arrives as a wire command; the bound host dispatches it.
    h.bound.host.receive({ type: "command", command: "ink" });
    expect(h.engine.state().ink).toBe(true);
    expect(h.lastBar()?.rows.find((r) => r.command === "ink")?.lit).toBe(true);
  });

  it("stops publishing after dispose", async () => {
    const h = harness();
    await settle();
    h.bound.dispose();
    const after = h.sent.length;
    h.engine.dispatch("ink");
    await settle();
    expect(h.sent.length).toBe(after);
  });
});
