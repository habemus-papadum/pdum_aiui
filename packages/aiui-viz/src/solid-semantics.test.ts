// @vitest-environment jsdom
/**
 * solid-semantics.test.ts — the semantics-pin suite (write-semantics proposal
 * §8 / M7). This file tests SOLID, not aiui: it pins the write/read contract
 * everything in this repo is built against, so a future Solid beta that
 * restores eager writes — or changes the boundary rule — turns up as a red
 * test instead of a silent behavior change underneath the machine code.
 *
 * The contract, in one line (M0): **a signal write is a transaction; it
 * commits at the next microtask; the reactive graph is the only reader of
 * your writes.** Solid 1.x had read-your-own-writes behind the IDENTICAL
 * API — these pins are what stop that prior from silently coming back.
 */
import {
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  createStore,
  flush,
  getObserver,
} from "solid-js";
import { createErrorBoundary } from "solid-js/internal";
import { describe, expect, it } from "vitest";

const microtask = (): Promise<void> => Promise.resolve();

describe("boundary reads are stale (the trap)", () => {
  it("read after write with no reactive context returns the PRE-write value", () => {
    const [x, setX] = createSignal("disarmed");
    setX("armed");
    expect(getObserver()).toBeNull(); // we ARE at an imperative boundary
    expect(x()).toBe("disarmed"); // …so the write is invisible to us
  });

  it("a DERIVED read is stale too — memos over fresh writes serve the old value", () => {
    // This is the fact that killed liveSignal: making the RAW value fresh
    // cannot help, because boundary code reads memos over it (cap labels,
    // claims), and those recompute only at commit. (The graph is built inside
    // a root; the writes happen OUTSIDE it — boundary code, like a dispatch.)
    const { label, setOn, dispose } = createRoot((dispose) => {
      const [on, setOn] = createSignal(false);
      const label = createMemo(() => (on() ? "lit" : "off"));
      return { label, setOn, dispose };
    });
    flush(); // settle initial computation
    setOn(true);
    expect(label()).toBe("off"); // stale — the memo has not recomputed
    flush();
    expect(label()).toBe("lit");
    dispose();
  });

  it("createStore defers identically — store write + store-derived memo, both stale", () => {
    const { state, setState, label, dispose } = createRoot((dispose) => {
      const [state, setState] = createStore({ phase: "disarmed" });
      const label = createMemo(() => state.phase);
      return { state, setState, label, dispose };
    });
    flush();
    setState((s) => {
      s.phase = "armed";
    });
    expect(state.phase).toBe("disarmed"); // a machineStore on createStore would fix nothing
    expect(label()).toBe("disarmed");
    flush();
    expect(state.phase).toBe("armed");
    dispose();
  });

  it("writes inside an owned scope (component/memo/root body) THROW in dev", () => {
    expect(() =>
      createRoot((dispose) => {
        const [, setX] = createSignal(0);
        setX(1); // a root body is an owned scope — Solid rejects the write
        dispose();
      }),
    ).toThrow(/REACTIVE_WRITE_IN_OWNED_SCOPE/);
  });

  it("{ ownedWrite: true } opts a signal out of the owned-scope throw", () => {
    // The opt-out that lets effects drive islands' internal signals — the
    // panel architecture was bent around a throw this one option disables.
    createRoot((dispose) => {
      const [x, setX] = createSignal(0, { ownedWrite: true });
      expect(() => setX(1)).not.toThrow();
      void x;
      dispose();
    });
  });
});

describe("the escape hatches (what boundary code uses instead)", () => {
  it("the setter RETURNS the written value while a read still serves the old one", () => {
    const [x, setX] = createSignal(1);
    const written = setX(2);
    expect(written).toBe(2); // branch on this…
    expect(x()).toBe(1); // …never on this
  });

  it("two set(v => v+1) in one tick compose — updaters resolve against the PENDING value", () => {
    const [x, setX] = createSignal(0);
    setX((v) => v + 1);
    setX((v) => v + 1);
    flush();
    expect(x()).toBe(2);
  });

  it("flush() commits: reads are fresh immediately after", () => {
    const [x, setX] = createSignal("disarmed");
    setX("armed");
    flush();
    expect(x()).toBe("armed");
  });

  it("flush(fn) commits the writes made inside fn", () => {
    const [x, setX] = createSignal(0);
    flush(() => {
      setX(42);
    });
    expect(x()).toBe(42);
  });

  it("flush(fn) runs EFFECT HANDLERS synchronously — the islands repaint before the next line", () => {
    // This is why F1 (stale reads) and F2 (forgotten syncs) are one problem:
    // a flush()-committed dispatch leaves state, memos, AND effect-driven
    // imperative surfaces all current by the time it returns.
    let painted = -1;
    const { setX, dispose } = createRoot((dispose) => {
      const [x, setX] = createSignal(0);
      createEffect(
        () => x(),
        (v) => {
          painted = v;
        },
      );
      return { setX, dispose };
    });
    flush();
    expect(painted).toBe(0);
    flush(() => setX(7));
    expect(painted).toBe(7); // the handler already ran
    dispose();
  });

  it("one await (a microtask) is enough to commit", async () => {
    const [x, setX] = createSignal(0);
    setX(9);
    await microtask();
    expect(x()).toBe(9);
  });
});

describe("the equality gate (what cell() builds `equals` and its state box on)", () => {
  it("a memo returning a new-but-equal object notifies every reader; `equals` closes the gate", () => {
    let naiveRuns = 0;
    let gatedRuns = 0;
    const { setX, dispose } = createRoot((dispose) => {
      const [x, setX] = createSignal(1);
      const naive = createMemo(() => ({ decade: Math.floor(x() / 10) }));
      const gated = createMemo(() => ({ decade: Math.floor(x() / 10) }), {
        equals: (a, b) => a.decade === b.decade,
      });
      createEffect(
        () => naive(),
        () => {
          naiveRuns++;
        },
      );
      createEffect(
        () => gated(),
        () => {
          gatedRuns++;
        },
      );
      return { setX, dispose };
    });
    flush();
    for (const v of [2, 3, 10]) {
      setX(v);
      flush();
    }
    expect(naiveRuns).toBe(4); // initial + one per write: a fresh object is always "new"
    expect(gatedRuns).toBe(2); // initial + the decade change
    dispose();
  });

  it("the gate applies to each async-iterable yield; `equals: false` reopens it", async () => {
    const macrotask = () => new Promise<void>((r) => setTimeout(r, 0));
    const byIdentity: number[] = [];
    const every: number[] = [];
    const dispose = createRoot((dispose) => {
      const gen = async function* () {
        for (const v of [1, 1, 2]) {
          await macrotask();
          yield v;
        }
      };
      const a = createMemo(() => gen());
      const b = createMemo(() => gen(), { equals: false });
      createEffect(
        () => a(),
        (v) => {
          byIdentity.push(v);
        },
      );
      createEffect(
        () => b(),
        (v) => {
          every.push(v);
        },
      );
      return dispose;
    });
    const t0 = Date.now();
    while (every.length < 3 && Date.now() - t0 < 2000) await macrotask();
    await macrotask();
    expect(every).toEqual([1, 1, 2]);
    expect(byIdentity).toEqual([1, 2]);
    dispose();
  });

  it("an error boundary's derivation closes its gate on an identical reference", () => {
    // cell() interns its state box so that a recompute landing in the same
    // state wakes no state reader — this is the Solid fact that rests on.
    const READY = Object.freeze({ state: "ready" });
    let freshRuns = 0;
    let internedRuns = 0;
    const { setX, dispose } = createRoot((dispose) => {
      const [x, setX] = createSignal(0);
      const fresh = createErrorBoundary(
        () => {
          x();
          return { state: "ready" };
        },
        () => ({ state: "errored" }),
      );
      const interned = createErrorBoundary(
        () => {
          x();
          return READY;
        },
        () => ({ state: "errored" }),
      );
      createEffect(
        () => fresh().state,
        () => {
          freshRuns++;
        },
      );
      createEffect(
        () => interned().state,
        () => {
          internedRuns++;
        },
      );
      return { setX, dispose };
    });
    flush();
    for (const v of [1, 2, 3]) {
      setX(v);
      flush();
    }
    expect(freshRuns).toBe(4); // a fresh box per run wakes the reader every time
    expect(internedRuns).toBe(1); // the same box never does
    dispose();
  });
});
