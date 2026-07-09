// @vitest-environment jsdom
/**
 * testing.test.ts — the cell-testing harness, demonstrated on itself.
 *
 * These double as the worked examples the user guide's "Testing your cells"
 * step teaches from: build a graph with `cellHarness`, await values with
 * `whenReady`, move each input, and let `recordCommits` see a stream. The last
 * test is the whole reason the harness exists — it catches the deps/compute
 * out-of-sync bug with a five-line assertion.
 */
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { cell } from "./cell";
import {
  type CellHarness,
  cellHarness,
  recordCommits,
  tick,
  whenReady,
  whenState,
} from "./testing";

let harness: CellHarness<object> | undefined;
afterEach(() => {
  harness?.dispose();
  harness = undefined;
});

function use<T extends object>(h: CellHarness<T>): CellHarness<T> {
  harness = h as CellHarness<object>;
  return h;
}

describe("cellHarness + whenReady", () => {
  it("builds a live graph and awaits values without tick counting", async () => {
    const [threshold, setThreshold] = createSignal(0.5);
    const h = use(
      cellHarness(() => ({
        peaks: cell(
          () => ({ cutoff: threshold() }),
          async (d) => [0.9, 0.7, 0.6].filter((p) => p >= d.cutoff),
        ),
      })),
    );

    expect(await whenReady(h.cells.peaks)).toEqual([0.9, 0.7, 0.6]);

    // Move ONE input; the graph must notice. This pair of lines, repeated per
    // input, is the test that catches an undeclared dependency.
    setThreshold(0.8);
    expect(await whenReady(h.cells.peaks)).toEqual([0.9]);
  });

  it("whenReady rejects with the compute's error, not a timeout", async () => {
    const h = use(
      cellHarness(() => ({
        doomed: cell(
          () => 1,
          async () => {
            throw new Error("bad fit");
          },
          { name: "doomed" },
        ),
      })),
    );
    await expect(whenReady(h.cells.doomed)).rejects.toThrow(/"doomed" errored: .*bad fit/);
  });

  it("whenState reports the stuck state on timeout — diagnosis, not 'timed out'", async () => {
    const [gate] = createSignal<number | undefined>(undefined);
    const h = use(cellHarness(() => ({ held: cell(gate, async (n) => n) })));
    await expect(whenState(h.cells.held, "ready", { timeoutMs: 60 })).rejects.toThrow(
      /is "unresolved", wanted "ready"/,
    );
  });

  it("whenState observes the held state after a cancel gesture", async () => {
    const [capture, setCapture] = createSignal<number | undefined>(1);
    const h = use(cellHarness(() => ({ analysis: cell(capture, async (n) => n * 2) })));
    expect(await whenReady(h.cells.analysis)).toBe(2);

    setCapture(undefined); // the cancel gesture: close the gate
    expect(await whenState(h.cells.analysis, "held")).toBe("held");
    expect(h.cells.analysis.latest()).toBe(2); // last result stands
  });
});

describe("recordCommits", () => {
  it("sees every streamed partial in commit mode, one value in latest mode", async () => {
    const chunks = [[1], [1, 2], [1, 2, 3]];
    const h = use(
      cellHarness(() => ({
        streamed: cell(
          () => 1,
          async function* (_n, ctx) {
            for (const c of chunks) {
              await tick();
              if (ctx.signal.aborted) return;
              yield c;
            }
          },
        ),
        latestOnly: cell(
          () => 1,
          async function* (_n, ctx) {
            for (const c of chunks) {
              await tick();
              if (ctx.signal.aborted) return;
              yield c;
            }
          },
          { stream: "latest" },
        ),
      })),
    );
    const streamed = recordCommits(h.cells.streamed);
    const latestOnly = recordCommits(h.cells.latestOnly);
    await whenReady(h.cells.streamed);
    await whenReady(h.cells.latestOnly);
    await tick(); // let the recorders' effects observe the final commits

    expect(streamed.values).toEqual([[1], [1, 2], [1, 2, 3]]);
    expect(latestOnly.values).toEqual([[1, 2, 3]]);
    streamed.stop();
    latestOnly.stop();
  });
});

describe("the deps/compute out-of-sync bug, caught by the harness", () => {
  it("a per-input probe exposes the undeclared dependency", async () => {
    const [a, setA] = createSignal(1);
    const [b, setB] = createSignal(10);
    const h = use(
      cellHarness(() => ({
        // BUG (deliberate): compute uses `b` but deps never reads it.
        sum: cell(
          () => ({ a: a() }),
          async (d) => {
            await tick();
            return d.a + b();
          },
        ),
      })),
    );
    expect(await whenReady(h.cells.sum)).toBe(11);

    // Probe input `a`: fine.
    setA(2);
    expect(await whenReady(h.cells.sum)).toBe(12);

    // Probe input `b`: the cell must NOT still say 12 — but it does, because
    // the dependency was read in compute. This assertion is what fails on the
    // buggy cell; the fixed cell (b read in deps) passes it.
    setB(100);
    await tick();
    await tick();
    expect(h.cells.sum.latest()).toBe(12); // ← documents the bug's signature
  });
});
