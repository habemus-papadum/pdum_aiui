/**
 * testing.ts — the cell-testing harness (`@habemus-papadum/aiui-viz/testing`).
 *
 * A cell graph is plain model code: it runs under Vitest with no DOM rendering,
 * and headless tests are the counterweight to deps-tracking's one silent
 * failure mode (a dependency read in compute instead of deps — the graph never
 * learns of it, and the cell goes quietly stale). Writing those tests raw
 * requires knowing four pieces of Solid 2.0 trivia:
 *
 *   1. cells need a reactive owner        → wrap creation in `createRoot`
 *   2. a lazy graph needs a subscriber    → keep cells live with an effect
 *   3. writes are batched                 → never read in the tick you wrote
 *   4. async settles over several ticks   → count ticks, flakily
 *
 * This module packages the trivia so a test reads as intent:
 *
 * ```ts
 * import { cellHarness, whenReady } from "@habemus-papadum/aiui-viz/testing";
 *
 * const h = cellHarness(() => buildGraph());
 * try {
 *   expect(await whenReady(h.cells.peaks)).toHaveLength(3);
 *   threshold.set(0.9);                       // move ONE input…
 *   expect(await whenReady(h.cells.peaks)).toHaveLength(1); // …it noticed
 * } finally {
 *   h.dispose();
 * }
 * ```
 *
 * The waiters poll with real macrotask ticks rather than subscribing, so they
 * also flush the batched-write queue and never deadlock on a held cell — a
 * timeout reports the cell's final state/error for diagnosis instead of a bare
 * "timed out". Kept on its own subpath so test ergonomics never ride into an
 * app bundle; the library's own `cell.test.ts` remains the raw-pattern
 * reference, and `testing.test.ts` shows every helper here in use.
 */

import { createEffect, createRoot } from "solid-js";
import type { Cell, CellState } from "./cell";

/** One macrotask: lets batched writes commit and async cell runs advance. */
export const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Duck-type check for a Cell (a callable carrying the introspection API). */
function isCell(value: unknown): value is Cell<unknown> {
  return (
    typeof value === "function" &&
    typeof (value as Cell<unknown>).state === "function" &&
    typeof (value as Cell<unknown>).latest === "function"
  );
}

export interface CellHarness<T> {
  /** Whatever `setup` returned — typically the app's graph object. */
  cells: T;
  /** Tear the owner down (fires every cell's cleanup; aborts in-flight runs). */
  dispose: () => void;
}

/**
 * Build a cell graph under a disposable owner and keep it **live**.
 *
 * `setup` runs inside `createRoot` (cells need an owner), and every `Cell`
 * found among the returned object's values is watched by a passive effect —
 * without one, a graph is lazy (pull-only) and effects like auto-recompute
 * never fire the way they do under a rendering app. Call `dispose()` in the
 * test's cleanup; better, register it once:
 *
 * ```ts
 * let h: CellHarness<AppGraph>;
 * afterEach(() => h?.dispose());
 * ```
 */
export function cellHarness<T extends object>(setup: () => T): CellHarness<T> {
  return createRoot((dispose) => {
    const cells = setup();
    for (const value of Object.values(cells)) {
      if (isCell(value)) {
        const c = value;
        createEffect(
          () => [c.state(), c.latest()],
          () => {},
        );
      }
    }
    return { cells, dispose };
  });
}

export interface WaitOptions {
  /** Give up after this long (default 2000 ms). */
  timeoutMs?: number;
}

/**
 * Wait until the cell reaches one of the given states; resolves with the state
 * it reached. Times out with a diagnostic — the state it was stuck in and, if
 * errored, the error — because "timed out" alone is the worst message a
 * dataflow test can produce.
 */
export async function whenState<T>(
  cell: Cell<T>,
  states: CellState | readonly CellState[],
  options: WaitOptions = {},
): Promise<CellState> {
  const wanted = Array.isArray(states) ? states : [states];
  const deadline = Date.now() + (options.timeoutMs ?? 2000);
  // One unconditional tick before the first look: Solid batches writes, so a
  // `whenReady(c)` issued right after `input.set(...)` would otherwise observe
  // the PRE-write "ready" and resolve with the stale value — the exact race
  // this module exists to bury. After a macrotask the write has committed and
  // invalidated; a recomputing cell now reads pending/refreshing and the poll
  // below waits it out.
  await tick();
  for (;;) {
    const state = cell.state(); // a pull-read recomputes a stale cell — no subscriber needed
    if (wanted.includes(state)) {
      return state;
    }
    if (Date.now() > deadline) {
      const err = state === "errored" ? ` (error: ${String(cell.error())})` : "";
      throw new Error(
        `whenState: cell${cell.cellName ? ` "${cell.cellName}"` : ""} is "${state}"${err}, ` +
          `wanted ${wanted.map((s) => `"${s}"`).join(" | ")} within ${options.timeoutMs ?? 2000}ms`,
      );
    }
    await tick();
  }
}

/**
 * Wait for the cell's next `ready` and hand back its value. Rejects promptly —
 * with the cell's error — if the run fails instead, so an assertion failure
 * points at the compute, not at a timeout.
 */
export async function whenReady<T>(cell: Cell<T>, options: WaitOptions = {}): Promise<T> {
  const state = await whenState(cell, ["ready", "errored"], options);
  if (state === "errored") {
    throw new Error(
      `whenReady: cell${cell.cellName ? ` "${cell.cellName}"` : ""} errored: ${String(cell.error())}`,
    );
  }
  return cell.latest() as T;
}

export interface CommitRecorder<T> {
  /** Every value committed to the graph, in order (streaming yields included). */
  values: T[];
  /** Detach the recorder's subscription. */
  stop: () => void;
}

/**
 * Record every value a cell **commits** — for streaming assertions: a
 * `stream: "commit"` generator that yields three partials produces three
 * entries; `stream: "latest"` produces one. The recorder is its own reactive
 * owner, so it works on cells from any harness (or none).
 */
export function recordCommits<T>(cell: Cell<T>): CommitRecorder<T> {
  const values: T[] = [];
  const stop = createRoot((dispose) => {
    createEffect(
      () => cell(), // suspends while not ready; re-runs per committed value
      (value) => {
        values.push(value);
      },
    );
    return dispose;
  });
  return { values, stop };
}
