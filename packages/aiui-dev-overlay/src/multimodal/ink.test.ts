// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Ink } from "./ink";

const inks: Ink[] = [];
const make = (
  onStroke = vi.fn(),
  onAutoClear = vi.fn(),
): { ink: Ink; onStroke: typeof onStroke } => {
  const ink = new Ink({ fadeSec: () => 0, onStroke, onAutoClear });
  inks.push(ink);
  return { ink, onStroke };
};

afterEach(() => {
  for (const ink of inks.splice(0)) {
    ink.dispose();
  }
});

describe("Ink remote pen", () => {
  it("commits a multi-point remote stroke through onStroke, like a local one", () => {
    const { ink, onStroke } = make();
    ink.remoteBegin("r1", { color: "#0af", width: 5 }, 10, 10);
    ink.remotePoint("r1", 20, 30);
    ink.remoteEnd("r1", 40, 10);

    expect(ink.hasInk()).toBe(true);
    expect(onStroke).toHaveBeenCalledTimes(1);
    expect(onStroke).toHaveBeenCalledWith(3, { x: 10, y: 10, w: 30, h: 20 });
  });

  it("drops a remote tap (fewer than two points)", () => {
    const { ink, onStroke } = make();
    ink.remoteBegin("r1", { color: "#0af", width: 5 }, 10, 10);
    ink.remoteEnd("r1");
    expect(ink.hasInk()).toBe(false);
    expect(onStroke).not.toHaveBeenCalled();
  });

  it("discards a cancelled remote stroke without committing", () => {
    const { ink, onStroke } = make();
    ink.remoteBegin("r1", { color: "#0af", width: 5 }, 10, 10);
    ink.remotePoint("r1", 20, 20);
    ink.remoteCancel("r1");
    expect(ink.hasInk()).toBe(false);
    expect(onStroke).not.toHaveBeenCalled();
  });

  it("ignores points/end for an unknown remote id", () => {
    const { ink } = make();
    expect(() => {
      ink.remotePoint("nope", 1, 1);
      ink.remoteEnd("nope", 2, 2);
      ink.remoteCancel("nope");
    }).not.toThrow();
    expect(ink.hasInk()).toBe(false);
  });

  it("composites committed remote ink into a target context", () => {
    const { ink } = make();
    ink.remoteBegin("r1", { color: "#0af", width: 5 }, 10, 10);
    ink.remotePoint("r1", 20, 20);
    ink.remoteEnd("r1", 30, 10);

    const calls: string[] = [];
    const ctx = new Proxy(
      {},
      {
        get: (_t, prop: string) =>
          prop === "canvas" ? {} : (..._a: unknown[]) => calls.push(prop),
        set: () => true,
      },
    ) as unknown as CanvasRenderingContext2D;
    ink.compositeInto(ctx, 0, 0, 1);
    expect(calls).toContain("stroke");
    expect(calls).toContain("quadraticCurveTo");
  });
});
