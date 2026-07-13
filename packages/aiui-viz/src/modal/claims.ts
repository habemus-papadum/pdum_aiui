/**
 * claims.ts — operations, derived: the async half of the mode engine
 * (docs/proposals/intent-client/01-mode-engine.md §3.4).
 *
 * A **claim** is a pure function from (state, context) to a *desired
 * operation* keyed by identity — "ink pointer on tab 42", "tab stream warm
 * on tab 7", "sampling at 1 fps" — or null when nothing is desired. The
 * reconciler diffs desired against actual after every commit and drives the
 * async appliers (acquire/release), each run under `guardedEffect` so
 * completion-time revalidation and hard ceilings are structural, not
 * remembered.
 *
 * This retires the hand-called `sync*` function as a category: the appliers
 * exist, but nobody calls them by hand — a forgotten sync becomes
 * structurally impossible ("a missed transition costs one reconcile, not a
 * wedged UI", generalized from reconcile.ts to async resources).
 *
 * Per-claim **status** — idle | pending | active | error | stale — is the
 * "neither on nor off" state the mode inventory kept finding (mic granted
 * but idle, stream warming, video on but not sampling): derived and
 * displayable, never stored in an ad-hoc flag.
 *
 * Semantics, precisely:
 *  - operations on one claim are strictly sequential (release completes
 *    before the next acquire starts); distinct claims are independent;
 *  - a desire change during an in-flight acquire supersedes it: the acquired
 *    value is released immediately (never adopted), and the newest desire is
 *    applied next — retraction truth: the newest desire wins, even when it
 *    is null;
 *  - an acquire error (or ceiling timeout) parks the claim in `error` until
 *    the desire CHANGES (or `retry()` is called) — no hot retry loops;
 *  - release errors are reported and the actual is dropped anyway (a release
 *    that throws must not wedge the claim).
 *
 * Realm rules: no Solid, no DOM — statuses flow through a callback; the
 * Solid adapter mirrors them into signals.
 */

import { guardedEffect } from "./effect";

export type ClaimPhase = "idle" | "pending" | "active" | "error" | "stale";

export interface ClaimStatus {
  phase: ClaimPhase;
  /** The desire this status refers to (undefined when idle). */
  desire?: unknown;
  /** The applier's error (or `{ timeout: true }`), when phase = "error". */
  error?: unknown;
}

export interface ClaimSpec<S, Ctx, D, A> {
  /** The pure derivation: what should exist right now (null = nothing). */
  derive: (state: S, ctx: Ctx) => D | null;
  /** Bring the operation into being. The signal aborts on supersession/ceiling. */
  acquire: (desire: D, signal: AbortSignal) => Promise<A>;
  /** Tear it down. Must be idempotent-ish; errors are reported, not fatal. */
  release?: (actual: A, desire: D) => void | Promise<void>;
  /** Hard ceiling for one acquire; omit for self-bounded transports. */
  ceilingMs?: number;
  /** Desire equality; defaults to structural (JSON) equality. */
  same?: (a: D, b: D) => boolean;
}

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous claim map — each entry checks its own D/A pair at declaration
export type ClaimSpecs<S, Ctx> = Readonly<Record<string, ClaimSpec<S, Ctx, any, any>>>;

export interface ClaimsOptions<S, Ctx> {
  getState: () => S;
  getCtx: () => Ctx;
  /** Status sink — fired on every phase change (the adapter mirrors to signals). */
  onStatus?: (name: string, status: ClaimStatus) => void;
  /** Failure sink; defaults to console.error. */
  onError?: (name: string, error: unknown) => void;
}

export interface ClaimsHandle {
  /**
   * Diff desired against actual and drive the appliers. Call after EVERY
   * engine commit and context change — unconditionally (wire it to
   * `engine.subscribe`); it is cheap when nothing changed.
   */
  reconcile(): void;
  /** Current status of one claim. */
  status(name: string): ClaimStatus;
  /** All statuses (a fresh snapshot object). */
  statuses(): Record<string, ClaimStatus>;
  /** Re-attempt a claim parked in `error` with its unchanged desire. */
  retry(name: string): void;
  /** Release everything and settle; the handle stays usable (reconcile re-acquires). */
  dispose(): Promise<void>;
}

const structuralSame = (a: unknown, b: unknown): boolean =>
  a === b || JSON.stringify(a) === JSON.stringify(b);

interface ClaimRuntime<D, A> {
  /** The newest derived desire — what settle() aims for. */
  desired: D | null;
  /** Monotonic: bumped whenever `desired` changes; stamps in-flight work. */
  generation: number;
  /** What is actually held right now, and the desire it was acquired for. */
  actual: A | undefined;
  actualDesire: D | undefined;
  /** The per-claim operation chain — strictly sequential. */
  chain: Promise<void>;
  status: ClaimStatus;
}

export function createClaims<S, Ctx>(
  specs: ClaimSpecs<S, Ctx>,
  options: ClaimsOptions<S, Ctx>,
): ClaimsHandle {
  const report =
    options.onError ??
    ((name: string, error: unknown) => {
      console.error(`[aiui-viz/modal] claim "${name}" applier failed`, error);
    });

  // biome-ignore lint/suspicious/noExplicitAny: runtime rows are erased; each spec's D/A was checked at its declaration
  const runtimes = new Map<string, ClaimRuntime<any, any>>();
  for (const name of Object.keys(specs)) {
    runtimes.set(name, {
      desired: null,
      generation: 0,
      actual: undefined,
      actualDesire: undefined,
      chain: Promise.resolve(),
      status: { phase: "idle" },
    });
  }

  const setStatus = (name: string, status: ClaimStatus): void => {
    const runtime = runtimes.get(name);
    if (runtime === undefined) {
      return;
    }
    runtime.status = status;
    options.onStatus?.(name, status);
  };

  /** One step of the per-claim chain: make actual match the newest desire. */
  const settle = async (name: string, generation: number): Promise<void> => {
    const spec = specs[name];
    const runtime = runtimes.get(name);
    if (runtime === undefined) {
      return;
    }
    if (generation !== runtime.generation) {
      return; // superseded — the newest desire has its own settle queued behind us
    }
    // Release whatever is held (the desire changed, so the old operation goes).
    if (runtime.actual !== undefined) {
      const held = runtime.actual;
      const heldFor = runtime.actualDesire;
      runtime.actual = undefined;
      runtime.actualDesire = undefined;
      try {
        await spec.release?.(held, heldFor);
      } catch (error) {
        report(name, error);
      }
    }
    if (generation !== runtime.generation) {
      return; // desire moved again while releasing
    }
    const desire = runtime.desired;
    if (desire === null) {
      setStatus(name, { phase: "idle" });
      return;
    }
    const outcome = await guardedEffect(
      {
        ...(spec.ceilingMs !== undefined ? { ceilingMs: spec.ceilingMs } : {}),
        stillValid: () => generation === runtime.generation,
      },
      (signal) => spec.acquire(desire, signal),
    );
    if (outcome.status === "ok") {
      runtime.actual = outcome.value;
      runtime.actualDesire = desire;
      setStatus(name, { phase: "active", desire });
      return;
    }
    if (outcome.status === "stale") {
      // Acquired for a desire that no longer holds: never adopt it — release
      // immediately; the superseding settle (already queued) applies the new
      // desire. The newest fold wins, even when it is empty.
      setStatus(name, { phase: "stale", desire });
      try {
        await spec.release?.(outcome.value, desire);
      } catch (error) {
        report(name, error);
      }
      return;
    }
    const error = outcome.status === "timeout" ? { timeout: true } : outcome.error;
    setStatus(name, { phase: "error", desire, error });
    report(name, error);
  };

  const aim = (name: string, desire: unknown): void => {
    const runtime = runtimes.get(name);
    if (runtime === undefined) {
      return;
    }
    runtime.desired = desire;
    runtime.generation += 1;
    const generation = runtime.generation;
    setStatus(name, { phase: "pending", desire: desire ?? undefined });
    runtime.chain = runtime.chain.then(() => settle(name, generation));
  };

  const reconcile = (): void => {
    const state = options.getState();
    const ctx = options.getCtx();
    for (const [name, spec] of Object.entries(specs)) {
      const runtime = runtimes.get(name);
      if (runtime === undefined) {
        continue;
      }
      const desire = spec.derive(state, ctx) ?? null;
      const same = spec.same ?? structuralSame;
      const unchanged =
        desire === null || runtime.desired === null
          ? desire === runtime.desired
          : same(desire, runtime.desired);
      if (unchanged) {
        continue;
      }
      aim(name, desire);
    }
  };

  return {
    reconcile,
    status: (name) => runtimes.get(name)?.status ?? { phase: "idle" },
    statuses: () => {
      const out: Record<string, ClaimStatus> = {};
      for (const [name, runtime] of runtimes) {
        out[name] = runtime.status;
      }
      return out;
    },
    retry: (name) => {
      const runtime = runtimes.get(name);
      if (runtime === undefined || runtime.status.phase !== "error") {
        return;
      }
      aim(name, runtime.desired);
    },
    dispose: async () => {
      for (const name of runtimes.keys()) {
        aim(name, null);
      }
      await Promise.all([...runtimes.values()].map((runtime) => runtime.chain));
    },
  };
}
