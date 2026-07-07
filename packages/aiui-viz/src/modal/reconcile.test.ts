// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createReconciler, type SurfaceRule } from "./reconcile";

type M = "idle" | "armed";

describe("createReconciler", () => {
  it("asserts every surface from the mode, on every call — assertion, not transition bookkeeping", () => {
    const seen: Record<string, M[]> = { veil: [], cursor: [] };
    const surfaces: SurfaceRule<M>[] = [
      { name: "veil", apply: (mode) => seen.veil.push(mode) },
      { name: "cursor", apply: (mode) => seen.cursor.push(mode) },
    ];
    const reconcile = createReconciler(surfaces);
    reconcile("armed");
    reconcile("armed"); // idempotent rules: re-asserting the same mode is fine
    reconcile("idle");
    expect(seen.veil).toEqual(["armed", "armed", "idle"]);
    expect(seen.cursor).toEqual(["armed", "armed", "idle"]);
  });

  it("isolates a throwing surface: the rest still run and onError names the culprit", () => {
    const boom = new Error("stranded veil");
    const applied: string[] = [];
    const onError = vi.fn();
    const reconcile = createReconciler<M>(
      [
        { name: "ring", apply: () => applied.push("ring") },
        {
          name: "veil",
          apply: () => {
            throw boom;
          },
        },
        { name: "cursor", apply: () => applied.push("cursor") },
      ],
      { onError },
    );
    reconcile("armed");
    // The safety net does not die on the first hole.
    expect(applied).toEqual(["ring", "cursor"]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith("veil", boom);
  });

  it("reports to console.error by default — a failing invariant is never silent", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const reconcile = createReconciler<M>([
        {
          name: "veil",
          apply: () => {
            throw new Error("nope");
          },
        },
      ]);
      reconcile("idle");
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0][0])).toContain('"veil"');
    } finally {
      spy.mockRestore();
    }
  });
});
