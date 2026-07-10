// @vitest-environment jsdom
/**
 * graph.test.ts — playbook layer 2, headless: the whole dataflow (controls →
 * worker cell → derived cells → derived tools) with ZERO real workers. jsdom
 * has no Worker, so the graph takes its worker as a parameter and this test
 * hands it a stub speaking the same run/cancel → progress/partial/done
 * protocol, computed synchronously from the SAME layer-1 math. The physics is
 * pinned in diffusion.test.ts; here we pin the wiring.
 */
import type { WorkerReply, WorkerRequest } from "@habemus-papadum/aiui-viz";
import { agentToolkit, dependencyEdges, registerStandardTools } from "@habemus-papadum/aiui-viz";
import {
  type CellHarness,
  cellHarness,
  recordCommits,
  resetControlSurface,
  whenReady,
  whenState,
} from "@habemus-papadum/aiui-viz/testing";
import { afterEach, describe, expect, it } from "vitest";
import { diffusionStep, initialProfile, stableDt } from "../lib/diffusion";
import type { EvolutionParams } from "./diffusion.worker";
import { buildGraph, type WalkthroughGraph } from "./graph";
import { ic, kappa } from "./store";

/**
 * A stub worker: the protocol shell re-implemented on the main thread over the
 * same pure math. Emits two cumulative partials and a done, so streaming
 * semantics are exercised too.
 */
class StubWorker {
  private listeners: Array<(e: MessageEvent) => void> = [];
  addEventListener(_: "message", fn: (e: MessageEvent) => void): void {
    this.listeners.push(fn);
  }
  removeEventListener(_: "message", fn: (e: MessageEvent) => void): void {
    this.listeners = this.listeners.filter((l) => l !== fn);
  }
  postMessage(msg: WorkerRequest<EvolutionParams>): void {
    if (msg.type !== "run") return;
    const p = msg.payload;
    const emit = (reply: WorkerReply<unknown>) =>
      queueMicrotask(() => {
        for (const l of this.listeners) l({ data: reply } as MessageEvent);
      });

    const dx = 1 / (p.n - 1);
    const dt = 0.9 * stableDt(p.kappa, dx);
    const r = (p.kappa * dt) / (dx * dx);
    let u: Float64Array = initialProfile(p.ic, p.n, p.seed);
    let scratch: Float64Array = new Float64Array(p.n);
    const steps = 32; // enough to move; speed matters more than fidelity here
    const frames = [{ t: 0, u: u.slice() }];
    for (let s = 1; s <= steps; s++) {
      diffusionStep(u, r, scratch);
      [u, scratch] = [scratch, u];
      if (s % 8 === 0) frames.push({ t: s * dt, u: u.slice() });
    }
    emit({ id: msg.id, type: "progress", value: 0.5 });
    emit({ id: msg.id, type: "partial", value: { frames: frames.slice(0, 2), t: frames[1].t } });
    emit({ id: msg.id, type: "done", value: { frames, t: frames[frames.length - 1].t } });
  }
}

const stub = () => new StubWorker() as unknown as Worker;

let h: CellHarness<WalkthroughGraph> | undefined;
afterEach(() => {
  h?.dispose();
  h = undefined;
  resetControlSurface();
});

describe("the walkthrough graph, headless", () => {
  it("streams partials, derives the profile, and probes each control", async () => {
    h = cellHarness(() => buildGraph(stub));
    const commits = recordCommits(h.cells.evolution);

    const first = await whenReady(h.cells.profile);
    expect(first.t).toBeGreaterThan(0);
    expect(commits.values.length).toBeGreaterThanOrEqual(2); // partial + done both committed

    kappa.set(0.5); // probe input 1: the evolution reruns, the profile follows
    const rerun = await whenReady(h.cells.profile);
    // The stub marches a FIXED 32 steps, and higher κ shrinks the stable dt —
    // so the rerun covers LESS physical time. (The real worker fixes simTime
    // instead; this assertion pins the stub's contract, the physics is pinned
    // in diffusion.test.ts.)
    expect(rerun.t).toBeLessThan(first.t);

    ic.set("step" as never); // probe input 2
    await whenReady(h.cells.profile);
    commits.stop();
  });

  it("errors compares against the analytic gaussian, and HOLDS for other ICs", async () => {
    h = cellHarness(() => buildGraph(stub));
    const errs = await whenReady(h.cells.errors);
    expect(errs.l2).toBeGreaterThan(0);
    expect(errs.l2).toBeLessThan(0.01); // the march tracks the reference

    ic.set("noise" as never); // no analytic reference → the cell goes quiet
    await whenState(h.cells.errors, "held");
    expect(h.cells.errors.latest()?.t).toBe(errs.t); // last result stands
  });

  it("the derived tools see the whole surface, and edges map the topology", async () => {
    h = cellHarness(() => buildGraph(stub));
    await whenReady(h.cells.errors);

    const kit = agentToolkit("walkthroughTest");
    registerStandardTools(kit);
    const brief = kit.handle().call("report") as {
      controls: Record<string, unknown>;
      actions: string[];
      edges: Record<string, string[]>;
    };
    expect(brief.controls).toMatchObject({ kappa: 0.1, points: 256, ic: "gaussian" });
    expect(brief.actions).toContain("re-seed");

    // The dependency topology, straight from the latest runs — no source
    // spelunking: evolution reads four controls; errors reads a control, a
    // cell, and another control.
    const edges = Object.fromEntries(dependencyEdges().map((e) => [e.cell, e.reads]));
    expect(edges.evolution).toEqual(
      expect.arrayContaining([
        { kind: "control", name: "kappa" },
        { kind: "control", name: "points" },
        { kind: "control", name: "ic" },
        { kind: "control", name: "simTime" },
      ]),
    );
    expect(edges.errors).toEqual(
      expect.arrayContaining([
        { kind: "control", name: "ic" },
        { kind: "cell", name: "profile" },
      ]),
    );

    const written = kit.handle().call("set", { name: "kappa", value: 99 }) as { value: number };
    expect(written.value).toBe(1); // clamped by the declaration in store.ts
  });
});
