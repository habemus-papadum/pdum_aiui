// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fadeStyle, INK_CHARGE, INK_HOLD, Ink } from "./ink";

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

describe("fadeStyle — the warp curve", () => {
  const at = (fraction: number, fadeMs = 6000) => fadeStyle(fraction * fadeMs, fadeMs);

  it("permanent ink (fadeMs <= 0) never changes, at any age", () => {
    for (const age of [0, 1_000, 60_000, 3_600_000]) {
      expect(fadeStyle(age, 0)).toEqual({ alpha: 1, widthScale: 1, glow: 0 });
    }
  });

  it("does NOTHING for the first 80% of a stroke's life", () => {
    // The old linear fade had the stroke visibly dying from the moment it was
    // drawn. Here it is simply ink, until it isn't.
    for (const p of [0, 0.25, 0.5, 0.79, INK_HOLD - 0.001]) {
      expect(at(p)).toEqual({ alpha: 1, widthScale: 1, glow: 0 });
    }
  });

  it("charges without dimming: opaque, thickening, heating toward white", () => {
    const chargeEnd = INK_HOLD + (1 - INK_HOLD) * INK_CHARGE; // 0.92
    const mid = at((INK_HOLD + chargeEnd) / 2);
    const end = at(chargeEnd - 0.0001);

    // Fully opaque throughout the tell — the change is size and colour.
    expect(mid.alpha).toBe(1);
    expect(end.alpha).toBe(1);
    // ...and both grow monotonically into the pop.
    expect(mid.widthScale).toBeGreaterThan(1);
    expect(end.widthScale).toBeGreaterThan(mid.widthScale);
    expect(mid.glow).toBeGreaterThan(0);
    expect(end.glow).toBeGreaterThan(mid.glow);
    expect(end.glow).toBeCloseTo(1, 2);
  });

  it("pops: most of the disappearance lands in the final instants", () => {
    const chargeEnd = INK_HOLD + (1 - INK_HOLD) * INK_CHARGE;
    // Halfway through the pop the stroke is still 3/4 there (1 - 0.5²)...
    const half = at((chargeEnd + 1) / 2);
    expect(half.alpha).toBeCloseTo(0.75, 2);
    // ...and it is gone exactly at the end of its life, not before.
    expect(at(0.999).alpha).toBeGreaterThan(0);
    expect(at(1).alpha).toBe(0);
    expect(at(1.5).alpha).toBe(0);
    // It leaves bigger than it lived — a burst, not a dissolve.
    expect(at(0.999).widthScale).toBeGreaterThan(1.9);
  });

  it("is monotone: a stroke never brightens or thins as it ages", () => {
    let previousAlpha = Number.POSITIVE_INFINITY;
    let previousWidth = 0;
    for (let p = 0; p <= 1; p += 0.01) {
      const style = at(p);
      expect(style.alpha).toBeLessThanOrEqual(previousAlpha + 1e-9);
      expect(style.widthScale).toBeGreaterThanOrEqual(previousWidth - 1e-9);
      previousAlpha = style.alpha;
      previousWidth = style.widthScale;
    }
  });

  it("scales with the duration — the shape is a fraction of life, not a clock", () => {
    // The same phase at 1s and at 10s, so the slider changes pace, not feel.
    for (const fadeMs of [1000, 6000, 10_000]) {
      expect(fadeStyle(0.5 * fadeMs, fadeMs).alpha).toBe(1);
      expect(fadeStyle(0.9 * fadeMs, fadeMs).alpha).toBe(1); // still charging
      expect(fadeStyle(1.0 * fadeMs, fadeMs).alpha).toBe(0);
    }
  });
});

describe("Ink.restartFade", () => {
  it("re-stamps the clocks without dropping strokes (flipping to vanishing)", () => {
    const { ink } = make();
    ink.remoteBegin("r1", { color: "#0af", width: 5 }, 10, 10);
    ink.remoteEnd("r1", 40, 10);
    expect(ink.strokeCount()).toBe(1);

    ink.restartFade();
    expect(ink.strokeCount()).toBe(1); // a restart is not a clear
    expect(ink.hasInk()).toBe(true);
  });
});
