/**
 * The weave — the persona plus the app's named slots.
 *
 * What is worth pinning here is the STRUCTURE, not the wording: the slots
 * render in the weaver's order under the weaver's headings, an absent slot is
 * indistinguishable from an empty one, and `extra` stays the unheaded escape
 * hatch it has always been.
 */
import { describe, expect, it } from "vitest";
import { ORACLE_BASE_PERSONA, weaveInstructions } from "./prompt";

describe("weaveInstructions", () => {
  it("is the bare persona when nothing is supplied", () => {
    expect(weaveInstructions()).toBe(ORACLE_BASE_PERSONA);
    expect(weaveInstructions({})).toBe(ORACLE_BASE_PERSONA);
  });

  it("renders slots in the WEAVER's order, whatever order they were written", () => {
    // The caller's key order must not reach the model: two apps writing the
    // same slots differently would otherwise produce differently-shaped
    // prompts, which is the thing named slots exist to prevent.
    const woven = weaveInstructions({
      extra: "Never mention the weather.",
      stance: "They are new here — offer the tour once.",
      context: "<tab url='/spectra' />",
      app: "A spectrum viewer.",
    });
    const order = ["About this app:", "Right now:", "For this conversation:", "Never mention"].map(
      (needle) => woven.indexOf(needle),
    );
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("heads the three named slots and leaves `extra` bare", () => {
    const woven = weaveInstructions({
      app: "A spectrum viewer.",
      context: "<tab url='/spectra' />",
      stance: "Be terse.",
      extra: "Never mention the weather.",
    });
    expect(woven).toContain("About this app: A spectrum viewer.");
    expect(woven).toContain("Right now: <tab url='/spectra' />");
    expect(woven).toContain("For this conversation: Be terse.");
    // The escape hatch: a heading here would just make it a fifth named slot
    // with a worse name.
    expect(woven).toContain("\n\nNever mention the weather.");
  });

  it("treats empty and absent identically — a partial record needs no padding", () => {
    // A resolver that has nothing to say about `context` this time returns a
    // record without it, or with "". Neither may leave a dangling heading.
    const partial = weaveInstructions({ app: "A spectrum viewer.", context: "" });
    expect(partial).toBe(weaveInstructions({ app: "A spectrum viewer." }));
    expect(partial).not.toContain("Right now:");
  });

  it("keeps the persona first and unmodified — it is the shared contract", () => {
    expect(weaveInstructions({ app: "x" }).startsWith(ORACLE_BASE_PERSONA)).toBe(true);
  });
});
