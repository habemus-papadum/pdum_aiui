/**
 * `liveSignal` — a signal with **read-your-own-writes**.
 *
 * The trap it retires (hit repeatedly in real apps — the extension panel
 * alone tripped over it five separate times: its phase machine, the ink
 * flag, selection presence, the key blip, and the channel port): Solid 2.0
 * BATCHES signal writes, so
 *
 * ```ts
 * setPhase("armed");
 * if (phase() === "armed") { … }   // ← reads the STALE value; branch skipped
 * ```
 *
 * silently does the wrong thing whenever a synchronous flow decides something
 * based on state it just wrote. UI rendering *wants* the batching; machine
 * logic wants sequential consistency. The hand-rolled fix was always the same
 * pair — a plain mutable variable for the machine, a signal for the JSX,
 * updated together — copied one more time at every bite.
 *
 * This is that pair, once:
 *
 *  - `set(v)` updates a plain field synchronously and notifies a version
 *    signal (writes of an identical value — `===` — notify nothing);
 *  - `get()` registers the reactive dependency (so JSX, effects, and cell
 *    deps re-run on change) but RETURNS the plain field — always current,
 *    even in the same tick as the write.
 *
 * One accessor serves both worlds; there is no stale copy to forget about.
 * Functional updates resolve against the CURRENT value, so two `set(n =>
 * n+1)` in one tick yield 2.
 *
 * When to reach for it: any state that a synchronous state machine reads to
 * decide its next transition — phases, mode flags, claims. When not to: pure
 * render state (an ordinary signal is fine), values needing HMR durability
 * (`durableSignal`), or anything with declared bounds (`control`).
 */
import { createSignal } from "solid-js";

export interface LiveSignal<T> {
  /** Current value — reactive to track, never stale to read. */
  get(): T;
  /** Write (value or updater). Returns what was written. */
  set(next: T | ((prev: T) => T)): T;
}

export function liveSignal<T>(initial: T): LiveSignal<T> {
  let now = initial;
  // A version counter, not the value: sidesteps signal equality/function-value
  // storage entirely — `now` is the single source of truth.
  const [version, setVersion] = createSignal(0);
  return {
    get() {
      version(); // subscribe (no-op outside tracking scopes)
      return now;
    },
    set(next) {
      const resolved = typeof next === "function" ? (next as (prev: T) => T)(now) : next;
      if (resolved !== now) {
        now = resolved;
        setVersion((v) => v + 1);
      }
      return now;
    },
  };
}
