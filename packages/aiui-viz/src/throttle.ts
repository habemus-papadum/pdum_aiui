/**
 * throttle.ts — the imperative boundary's outbound valve.
 *
 * The rule for an imperative island (a rAF loop, a WebGL engine, a pen recorder
 * seeing 120 samples a second) is: *never touch a signal in the hot loop*.
 * Publish **one snapshot into one signal at a slow cadence** — around 4 Hz, fast
 * enough that a human watching a readout sees it move, slow enough that the
 * reactive graph is not re-run per frame. Every island in this repo obeys that
 * rule, and every island implements it slightly differently: a `setInterval`
 * next to the loop, a frame counter, a "has it been 250 ms?" check.
 *
 * That is not a *kind of signal*. It is a **write policy** on a signal you
 * already have — which is why this wraps a `SignalBox` rather than inventing a
 * parallel one. Durability and rate-limiting are orthogonal, and they compose:
 *
 * ```ts
 * // survives hot edits AND never commits more than 4× a second
 * export const telemetry = throttled(durableSignal("telemetry", empty), 4);
 *
 * // the island writes as often as it likes; the graph sees 4 Hz
 * recorder.onSample = (s) => telemetry.set(accumulate(s));
 * ```
 *
 * The semantics are a **throttle with a trailing edge**, and the trailing edge
 * is the part that matters: the first write lands immediately (so the UI reacts
 * at once), writes inside the window are coalesced with latest-wins, and the
 * **last value always lands** — within one interval, even if the island then
 * goes quiet forever. A naive "publish every 250 ms if something changed" timer
 * has the same average cost and drops the final sample of every stroke, which is
 * precisely the sample you were watching for.
 *
 * A throttled box is **write-only from the island's side**: its `get` is for the
 * reactive graph (components, cell deps), and the island reads its own plain
 * fields, which are always current. Do not read one back to decide something —
 * by construction it lags.
 */

import type { Accessor } from "solid-js";
import type { SignalBox } from "./durable";

/** A signal whose writes are rate-limited. `get` is for the graph, not the island. */
export interface ThrottledBox<T> {
  /** The last *published* value. Reactive; lags the island by up to one interval. */
  get: Accessor<T>;
  /** Offer a value (or an updater over the last offered one). Publishes on the graph's schedule. */
  set(next: T | ((previous: T) => T)): void;
  /** Publish any coalesced value right now — for teardown, and for tests. */
  flush(): void;
}

/**
 * Rate-limit a signal's writes to at most `hz` commits per second, keeping the
 * latest value and never losing the last one. See the module docblock.
 */
export function throttled<T>(box: SignalBox<T>, hz: number): ThrottledBox<T> {
  const interval = 1000 / Math.max(0.001, hz);

  // The last value OFFERED — the island's truth, tracked here rather than read
  // back from the box. Reading the box would be both stale (writes commit at the
  // next microtask) and noisy (it would trip durableSignal's stale-read guard).
  let latest = box.get();
  let coalesced = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const publish = (): void => {
    coalesced = false;
    // An updater, not a bare value: a Setter treats a function argument as an
    // update, which is also what makes this correct when T is itself a function.
    box.set(() => latest);
  };

  const openWindow = (): void => {
    timer = setTimeout(() => {
      timer = undefined;
      if (coalesced) {
        publish(); // the trailing edge: the last value always lands
        openWindow(); // …and it opens a window of its own, so a busy island stays at hz
      }
    }, interval);
  };

  return {
    get: box.get,

    set(next) {
      latest = typeof next === "function" ? (next as (previous: T) => T)(latest) : (next as T);
      if (timer !== undefined) {
        coalesced = true; // inside the window: latest wins, publish when it closes
        return;
      }
      publish(); // the leading edge: the first write is never delayed
      openWindow();
    },

    flush() {
      if (coalesced) {
        publish();
      }
    },
  };
}
