// @vitest-environment jsdom
/**
 * cell.test.ts — the semantics of `cell()` itself, headless.
 *
 * Cells are deliberately not UI: a cell graph is plain model code that runs
 * under Vitest with no DOM rendering, which is exactly how an app should test
 * its own dataflow (the user guide's "Testing your cells" section builds on
 * these patterns). Each describe block pins one part of the contract:
 *
 *   - deps gating and the `held` state (an explicit gate is not "refreshing")
 *   - dependency tracking, including the deps/compute out-of-sync bug
 *   - promise computes: pending → ready, supersession aborts, keep-latest
 *   - generator computes: commit vs latest stream modes, settledOnly
 *   - errors: error(), latest() across errors, refetch()
 *   - progress and ctx.previous
 *   - the named-cell registry lifecycle
 */
import { createEffect, createRoot, createSignal } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { type Cell, cell, cellByName, cellRegistry, settledOnly } from "./cell";

const tick = () => new Promise((r) => setTimeout(r, 0));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
});

/** Build cells inside an owner and keep them live with a passive watcher. */
function root<T>(setup: () => T): T {
  return createRoot((d) => {
    dispose = d;
    const out = setup();
    return out;
  });
}

/** Subscribe to a cell so the graph is live (push-based) during the test. */
function watch(c: Cell<unknown>): void {
  createEffect(
    () => [c.state(), c.latest()],
    () => {},
  );
}

describe("deps gating and the held state", () => {
  it("walks unresolved → pending → ready → held as the gate opens and closes", async () => {
    const [field, setField] = createSignal<number | undefined>(undefined);
    const c = root(() => {
      const c = cell(field, async (n) => n * 2);
      watch(c);
      return c;
    });
    await tick();

    // Gate closed, no value yet: unresolved (never "held" — there is nothing held).
    expect(c.state()).toBe("unresolved");
    expect(c.latest()).toBeUndefined();
    expect(c.loading()).toBe(false);

    setField(21);
    await tick();
    await tick();
    expect(c.state()).toBe("ready");
    expect(c()).toBe(42);

    // The cancel gesture: close the gate again. The old value stands, nothing
    // is running, and the cell says so — held, not refreshing.
    setField(undefined);
    await tick();
    expect(c.state()).toBe("held");
    expect(c.latest()).toBe(42); // last result still served
    expect(c.loading()).toBe(false); // no spinner, no stripe
    expect(c.settled()).toBe(true);

    // Reopen: recompute from the new deps.
    setField(5);
    await tick();
    await tick();
    expect(c.state()).toBe("ready");
    expect(c.latest()).toBe(10);
  });

  it("held is the explicit gate; a recomputing upstream is refreshing", async () => {
    const [n, setN] = createSignal(1);
    const [gate, setGate] = createSignal(true);
    const { down } = root(() => {
      const up = cell(n, async (v) => {
        await sleep(20);
        return v;
      });
      const down = cell(
        () => (gate() ? { v: up() } : undefined),
        async (d) => d.v * 10,
      );
      watch(up);
      watch(down);
      return { up, down };
    });
    await sleep(40);
    expect(down.latest()).toBe(10);

    // Upstream recomputing: a new value IS coming, and it arrives. (The
    // mid-flight "refreshing" read is pinned by the single-level promise test;
    // across a chain, Solid may serve stale values to untracked pull-reads, so
    // asserting the transient here would test the scheduler, not the cell.)
    setN(2);
    await sleep(40);
    expect(down.latest()).toBe(20);

    // Explicit gate: nothing is coming — held.
    setGate(false);
    await tick();
    expect(down.state()).toBe("held");
    expect(down.latest()).toBe(20);
  });

  it("false, null, and undefined all close the gate — booleans must be boxed", async () => {
    const [on, setOn] = createSignal(false);
    // The WRONG shape: `deps: on` would gate the cell whenever the flag is
    // false. The right shape boxes it, so `false` is a value, not a gate.
    const c = root(() => {
      const c = cell(
        () => ({ enabled: on() }),
        (d) => (d.enabled ? "on" : "off"),
      );
      watch(c);
      return c;
    });
    await tick();
    expect(c.latest()).toBe("off"); // ran, despite the false flag
    setOn(true);
    await tick();
    expect(c.latest()).toBe("on");
  });
});

describe("dependency tracking", () => {
  it("re-runs when a dep read in `deps` changes", async () => {
    const [a, setA] = createSignal(1);
    let runs = 0;
    const c = root(() => {
      const c = cell(
        () => ({ a: a() }),
        async (d) => {
          runs++;
          return d.a;
        },
      );
      watch(c);
      return c;
    });
    await tick();
    expect(runs).toBe(1);
    setA(2);
    await tick();
    await tick();
    expect(runs).toBe(2);
    expect(c.latest()).toBe(2);
  });

  it("the out-of-sync bug: a dep read only inside compute after an await is invisible", async () => {
    const [a] = createSignal(1);
    const [b, setB] = createSignal(10);
    let runs = 0;
    const c = root(() => {
      const c = cell(
        () => ({ a: a() }), // BUG (deliberate): b is used below but not declared here
        async (d) => {
          runs++;
          await tick(); // past the first await, reads are untracked
          return d.a + b();
        },
      );
      watch(c);
      return c;
    });
    await tick();
    await tick();
    expect(c.latest()).toBe(11);

    // b changes — and the cell does NOT recompute. This is the failure mode
    // the guide warns about: deps and compute drifted out of sync. The fix is
    // to read b in deps and take it off the bundle.
    setB(100);
    await tick();
    await tick();
    expect(runs).toBe(1);
    expect(c.latest()).toBe(11); // stale — silently wrong until `a` moves
  });
});

describe("promise computes", () => {
  it("goes pending → ready and aborts a superseded run's signal", async () => {
    const [q, setQ] = createSignal(1);
    const signals: AbortSignal[] = [];
    const c = root(() => {
      const c = cell(q, async (n, ctx) => {
        signals.push(ctx.signal);
        await sleep(30);
        return n;
      });
      watch(c);
      return c;
    });
    await tick();
    expect(c.state()).toBe("pending");
    expect(c.latest()).toBeUndefined();

    // Supersede while run 1 is in flight.
    setQ(2);
    await tick();
    expect(signals[0]?.aborted).toBe(true); // run 1 really cancelled
    await sleep(50);
    expect(c.state()).toBe("ready");
    expect(c.latest()).toBe(2);
    expect(signals[1]?.aborted).toBe(false);
  });

  it("keeps serving the previous value (refreshing) while a new run is in flight", async () => {
    const [q, setQ] = createSignal(1);
    const c = root(() => {
      const c = cell(q, async (n) => {
        await sleep(20);
        return n * 10;
      });
      watch(c);
      return c;
    });
    await sleep(40);
    expect(c.latest()).toBe(10);

    setQ(2);
    await tick();
    expect(c.state()).toBe("refreshing");
    expect(c.loading()).toBe(true);
    expect(c.latest()).toBe(10); // the keep-latest contract
    await sleep(40);
    expect(c.latest()).toBe(20);
  });

  it("hands ctx.previous the prior settled value", async () => {
    const [q, setQ] = createSignal(1);
    const previous: Array<number | undefined> = [];
    root(() => {
      const c = cell(q, async (n, ctx) => {
        previous.push(ctx.previous);
        return n;
      });
      watch(c);
    });
    await tick();
    await tick();
    setQ(2);
    await tick();
    await tick();
    expect(previous).toEqual([undefined, 1]);
  });
});

describe("generator computes (streaming)", () => {
  it("commit mode: every yield commits, and downstream recomputes per partial", async () => {
    const [go, setGo] = createSignal<number | undefined>(undefined);
    const seen: number[][] = [];
    const { up } = root(() => {
      const up = cell(go, async function* (_n, ctx) {
        for (const chunk of [[1], [1, 2], [1, 2, 3]]) {
          await tick();
          if (ctx.signal.aborted) return;
          yield chunk;
        }
      });
      const down = cell(
        () => ({ rows: up() }),
        (d) => {
          seen.push(d.rows);
          return d.rows.length;
        },
      );
      watch(up);
      watch(down);
      return { up };
    });
    setGo(1);
    await sleep(30);
    expect(up.state()).toBe("ready");
    expect(up.settled()).toBe(true);
    expect(seen).toEqual([[1], [1, 2], [1, 2, 3]]); // one downstream run per yield
  });

  it("latest mode: partials are visible on latest(), the graph commits once", async () => {
    const [go, setGo] = createSignal<number | undefined>(undefined);
    const commits: number[][] = [];
    const partials: Array<number[] | undefined> = [];
    root(() => {
      const up = cell(
        go,
        async function* (_n, ctx) {
          for (const chunk of [[1], [1, 2], [1, 2, 3]]) {
            await tick();
            if (ctx.signal.aborted) return;
            yield chunk;
          }
        },
        { stream: "latest" },
      );
      const down = cell(
        () => ({ rows: up() }),
        (d) => {
          commits.push(d.rows);
          return d.rows.length;
        },
      );
      watch(up);
      watch(down);
      createEffect(
        () => up.latest(),
        (v) => {
          if (v) partials.push(v);
        },
      );
      return { up };
    });
    setGo(1);
    await sleep(30);
    expect(commits).toEqual([[1, 2, 3]]); // exactly one downstream run
    expect(partials.length).toBeGreaterThan(1); // but the stream was watchable
  });

  it("settledOnly: a consumer opts out of partials while others stream", async () => {
    const [go, setGo] = createSignal<number | undefined>(undefined);
    const streaming: number[] = [];
    const settledRuns: number[] = [];
    root(() => {
      const up = cell(go, async function* (_n, ctx) {
        for (const chunk of [[1], [1, 2], [1, 2, 3]]) {
          await tick();
          if (ctx.signal.aborted) return;
          yield chunk;
        }
      });
      const live = cell(
        () => ({ rows: up() }),
        (d) => {
          streaming.push(d.rows.length);
          return d.rows.length;
        },
      );
      const settledView = cell(
        () => ({ rows: settledOnly(up) }), // holds until the run completes
        (d) => {
          settledRuns.push(d.rows.length);
          return d.rows.length;
        },
      );
      watch(up);
      watch(live);
      watch(settledView);
    });
    setGo(1);
    await sleep(30);
    expect(streaming).toEqual([1, 2, 3]); // saw every partial
    expect(settledRuns).toEqual([3]); // saw only the completed run
  });

  it("a generator that finishes without yielding errors the cell", async () => {
    const c = root(() => {
      const c = cell(
        () => 1,
        async function* () {}, // empty on purpose: never yielding IS the case under test
      );
      watch(c);
      return c;
    });
    await sleep(10);
    expect(c.state()).toBe("errored");
    expect(String(c.error())).toContain("finished without yielding");
  });
});

describe("errors and refetch", () => {
  it("errored keeps latest(), reports error(), and refetch() re-runs", async () => {
    const [q, setQ] = createSignal(1);
    let failNext = false;
    const c = root(() => {
      const c = cell(q, async (n) => {
        if (failNext) throw new Error("boom");
        return n * 10;
      });
      watch(c);
      return c;
    });
    await tick();
    await tick();
    expect(c.latest()).toBe(10);

    failNext = true;
    setQ(2);
    await sleep(10);
    expect(c.state()).toBe("errored");
    expect(String(c.error())).toContain("boom");
    expect(c.latest()).toBe(10); // the pre-error value survives

    failNext = false;
    c.refetch(); // routes through the error boundary's reset
    await sleep(10);
    expect(c.state()).toBe("ready");
    expect(c.latest()).toBe(20);
  });
});

describe("progress", () => {
  it("reports within a run and resets to undefined at the start of the next", async () => {
    const [q, setQ] = createSignal(1);
    let release: () => void = () => {};
    const c = root(() => {
      const c = cell(q, async (n, ctx) => {
        // Report after the first await, as real code does (chunk loops, worker
        // messages). A progress call in the synchronous prologue is wiped by
        // the run's own reset, which happens when Solid first pulls the run.
        await tick();
        ctx.progress(0.5);
        await new Promise<void>((r) => {
          release = r;
        });
        return n;
      });
      watch(c);
      return c;
    });
    await tick();
    await tick();
    expect(c.progress()).toBe(0.5);
    release();
    await tick();
    await tick();
    expect(c.state()).toBe("ready");

    setQ(2); // a new run begins…
    await tick();
    expect(c.progress()).toBeUndefined(); // …with a clean progress slate
    release();
  });
});

describe("the named-cell registry", () => {
  it("mirrors name→loc on window for framework-agnostic consumers", () => {
    // The attribution ladder (the intent runtime's VS Code ladder, the intent
    // client's jump mode) resolves a bare manual `data-cell="name"` stamp to
    // the cell's definition site through window.__aiuiCells — without
    // importing aiui-viz. This bridge is what retired the runtime-internals
    // spike.
    const bridge = (
      window as unknown as { __aiuiCells?: { loc(name: string): string | undefined } }
    ).__aiuiCells;
    expect(bridge).toBeDefined();

    let d: () => void = () => {};
    createRoot((dd) => {
      d = dd;
      cell(
        () => 1,
        (n) => n,
        { name: "grStats", loc: "src/model/graph.ts:31" },
      );
    });
    expect(bridge?.loc("grStats")).toBe("src/model/graph.ts:31");
    expect(bridge?.loc("mystery")).toBeUndefined();
    d();
    expect(bridge?.loc("grStats")).toBeUndefined(); // deregistered with its owner
  });

  it("registers on creation and deregisters when the owner is disposed", async () => {
    let d2: () => void = () => {};
    createRoot((d) => {
      d2 = d;
      cell(
        () => 1,
        (n) => n,
        { name: "census", loc: "graph.ts:12" },
      );
    });
    expect(cellRegistry().map((c) => c.name)).toContain("census");
    expect(cellByName("census")?.loc).toBe("graph.ts:12");

    d2(); // graph hot-swap or teardown
    expect(cellRegistry().map((c) => c.name)).not.toContain("census");
  });
});
