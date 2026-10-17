/**
 * claims.test.ts — the claim reconciler: desired-vs-actual diffing, strict
 * per-claim sequencing, supersession ("the newest desire wins, even when it
 * is null"), status transitions, error parking + retry.
 */
import { describe, expect, it, vi } from "vitest";
import { type ClaimStatus, createClaims } from "./claims";

interface S {
  phase: string;
  ink: boolean;
}
interface Ctx {
  tab: number | undefined;
}

/** A manually-resolvable acquire, with a call log shared across appliers. */
function deferredApplier(log: string[]) {
  let resolveNext: ((value: string) => void) | undefined;
  let rejectNext: ((error: unknown) => void) | undefined;
  return {
    acquire: vi.fn((desire: { tab: number }) => {
      log.push(`acquire:${desire.tab}`);
      return new Promise<string>((resolve, reject) => {
        resolveNext = (value) => resolve(value);
        rejectNext = (error) => reject(error);
      });
    }),
    release: vi.fn((actual: string) => {
      log.push(`release:${actual}`);
    }),
    resolve: (value: string) => resolveNext?.(value),
    reject: (error: unknown) => rejectNext?.(error),
  };
}

/** Let queued microtasks (the claim chains) run. */
const settle = async (rounds = 12): Promise<void> => {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
};

const inkPointerDerive = (state: S, ctx: Ctx) =>
  state.phase === "turn" && state.ink && ctx.tab !== undefined ? { tab: ctx.tab } : null;

describe("derive → acquire → active", () => {
  it("acquires when the derivation first wants the operation, with status milestones", async () => {
    const log: string[] = [];
    const applier = deferredApplier(log);
    const statuses: ClaimStatus[] = [];
    let state: S = { phase: "disarmed", ink: false };
    const ctx: Ctx = { tab: 7 };
    const claims = createClaims<S, Ctx>(
      {
        inkPointer: {
          derive: inkPointerDerive,
          acquire: applier.acquire,
          release: applier.release,
        },
      },
      {
        getState: () => state,
        getCtx: () => ctx,
        onStatus: (_name, status) => statuses.push(status),
      },
    );

    claims.reconcile();
    expect(log).toEqual([]); // nothing desired yet
    expect(claims.status("inkPointer").phase).toBe("idle");

    state = { phase: "turn", ink: true };
    claims.reconcile();
    expect(claims.status("inkPointer").phase).toBe("pending");
    await settle();
    expect(log).toEqual(["acquire:7"]);
    applier.resolve("pointer@7");
    await settle();
    expect(claims.status("inkPointer")).toMatchObject({ phase: "active", desire: { tab: 7 } });
    expect(statuses.map((s) => s.phase)).toEqual(["pending", "active"]);
  });

  it("an unchanged desire is a no-op — structural equality, fresh objects included", async () => {
    const log: string[] = [];
    const applier = deferredApplier(log);
    const state: S = { phase: "turn", ink: true };
    const claims = createClaims<S, Ctx>(
      {
        inkPointer: {
          derive: inkPointerDerive,
          acquire: applier.acquire,
          release: applier.release,
        },
      },
      { getState: () => state, getCtx: () => ({ tab: 7 }) }, // derive returns a NEW {tab:7} each call
    );
    claims.reconcile();
    applier.resolve("pointer@7");
    await settle();
    claims.reconcile();
    claims.reconcile();
    await settle();
    expect(applier.acquire).toHaveBeenCalledTimes(1);
  });
});

describe("desire changes", () => {
  it("releases the old operation before acquiring the new — strictly sequential", async () => {
    const log: string[] = [];
    const applier = deferredApplier(log);
    const ctx: Ctx = { tab: 7 };
    const state: S = { phase: "turn", ink: true };
    const claims = createClaims<S, Ctx>(
      {
        inkPointer: {
          derive: inkPointerDerive,
          acquire: applier.acquire,
          release: applier.release,
        },
      },
      { getState: () => state, getCtx: () => ctx },
    );
    claims.reconcile();
    await settle(); // the chain must reach acquire before we can resolve it
    applier.resolve("pointer@7");
    await settle();

    ctx.tab = 9; // tab switch re-points the claim
    claims.reconcile();
    await settle();
    expect(log).toEqual(["acquire:7", "release:pointer@7", "acquire:9"]);
    applier.resolve("pointer@9");
    await settle();
    expect(claims.status("inkPointer")).toMatchObject({ phase: "active", desire: { tab: 9 } });
  });

  it("null desire releases and parks idle", async () => {
    const log: string[] = [];
    const applier = deferredApplier(log);
    let state: S = { phase: "turn", ink: true };
    const claims = createClaims<S, Ctx>(
      {
        inkPointer: {
          derive: inkPointerDerive,
          acquire: applier.acquire,
          release: applier.release,
        },
      },
      { getState: () => state, getCtx: () => ({ tab: 7 }) },
    );
    claims.reconcile();
    await settle();
    applier.resolve("pointer@7");
    await settle();

    state = { phase: "armed", ink: true }; // turn closed
    claims.reconcile();
    await settle();
    expect(log).toEqual(["acquire:7", "release:pointer@7"]);
    expect(claims.status("inkPointer").phase).toBe("idle");
  });

  it("supersession mid-acquire: the in-flight result is NEVER adopted — released, newest wins", async () => {
    const log: string[] = [];
    const applier = deferredApplier(log);
    const ctx: Ctx = { tab: 7 };
    const state: S = { phase: "turn", ink: true };
    const claims = createClaims<S, Ctx>(
      {
        inkPointer: {
          derive: inkPointerDerive,
          acquire: applier.acquire,
          release: applier.release,
        },
      },
      { getState: () => state, getCtx: () => ctx },
    );
    claims.reconcile();
    await settle();
    expect(log).toEqual(["acquire:7"]); // in flight…

    ctx.tab = 9;
    claims.reconcile(); // …superseded before it lands
    applier.resolve("pointer@7"); // the stale acquisition completes anyway
    await settle();
    applier.resolve("pointer@9");
    await settle();
    expect(log).toEqual(["acquire:7", "release:pointer@7", "acquire:9"]);
    expect(claims.status("inkPointer")).toMatchObject({ phase: "active", desire: { tab: 9 } });
  });
});

describe("failure", () => {
  it("an acquire error parks the claim in `error` — no hot retry on same-desire reconciles", async () => {
    const log: string[] = [];
    const applier = deferredApplier(log);
    const onError = vi.fn();
    const state: S = { phase: "turn", ink: true };
    const claims = createClaims<S, Ctx>(
      {
        inkPointer: {
          derive: inkPointerDerive,
          acquire: applier.acquire,
          release: applier.release,
        },
      },
      { getState: () => state, getCtx: () => ({ tab: 7 }), onError },
    );
    claims.reconcile();
    await settle();
    applier.reject(new Error("tabCapture said no"));
    await settle();
    expect(claims.status("inkPointer").phase).toBe("error");
    expect(onError).toHaveBeenCalledTimes(1);

    claims.reconcile(); // same desire → parked, not a retry loop
    await settle();
    expect(applier.acquire).toHaveBeenCalledTimes(1);

    claims.retry("inkPointer"); // the explicit second chance
    await settle();
    expect(applier.acquire).toHaveBeenCalledTimes(2);
    applier.resolve("pointer@7"); // resolves the retry's (latest) acquire
    await settle();
    expect(claims.status("inkPointer").phase).toBe("active");
  });

  it("a ceiling timeout is an error with { timeout: true }", async () => {
    vi.useFakeTimers();
    try {
      const state: S = { phase: "turn", ink: true };
      const claims = createClaims<S, Ctx>(
        {
          inkPointer: {
            derive: inkPointerDerive,
            acquire: () => new Promise<string>(() => {}), // never lands
            ceilingMs: 50,
          },
        },
        { getState: () => state, getCtx: () => ({ tab: 7 }), onError: () => {} },
      );
      claims.reconcile();
      await vi.advanceTimersByTimeAsync(60);
      expect(claims.status("inkPointer")).toMatchObject({
        phase: "error",
        error: { timeout: true },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a throwing release is reported and the claim moves on", async () => {
    const onError = vi.fn();
    let state: S = { phase: "turn", ink: true };
    const claims = createClaims<S, Ctx>(
      {
        inkPointer: {
          derive: inkPointerDerive,
          acquire: async (desire: { tab: number }) => `pointer@${desire.tab}`,
          release: () => {
            throw new Error("surface already gone");
          },
        },
      },
      { getState: () => state, getCtx: () => ({ tab: 7 }), onError },
    );
    claims.reconcile();
    await settle();
    state = { phase: "armed", ink: true };
    claims.reconcile();
    await settle();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(claims.status("inkPointer").phase).toBe("idle"); // not wedged
  });
});

describe("dispose", () => {
  it("releases everything and settles", async () => {
    const log: string[] = [];
    const applier = deferredApplier(log);
    const state: S = { phase: "turn", ink: true };
    const claims = createClaims<S, Ctx>(
      {
        inkPointer: {
          derive: inkPointerDerive,
          acquire: applier.acquire,
          release: applier.release,
        },
      },
      { getState: () => state, getCtx: () => ({ tab: 7 }) },
    );
    claims.reconcile();
    await settle();
    applier.resolve("pointer@7");
    await settle();
    const done = claims.dispose();
    await settle();
    await done;
    expect(log).toEqual(["acquire:7", "release:pointer@7"]);
    expect(claims.status("inkPointer").phase).toBe("idle");
  });
});
