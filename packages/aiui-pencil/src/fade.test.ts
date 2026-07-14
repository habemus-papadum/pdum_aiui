import { describe, expect, it } from "vitest";
import { crossfadeStyle, FULL_STYLE, fadeStyle, heat, INK_HOLD, isFullStyle } from "./fade";

describe("fadeStyle — the warp curve", () => {
  it("is permanent ink when fadeMs <= 0", () => {
    expect(fadeStyle(99999, 0)).toEqual(FULL_STYLE);
    expect(fadeStyle(99999, -1)).toEqual(FULL_STYLE);
  });

  it("does NOTHING for the first 80% of the stroke's life", () => {
    // The whole point of the curve. A linear fade makes a stroke look sick from
    // the moment it is drawn; this one is simply ink until it isn't.
    for (const p of [0, 0.25, 0.5, 0.79]) {
      expect(fadeStyle(p * 1000, 1000)).toEqual(FULL_STYLE);
    }
    expect(INK_HOLD).toBe(0.8);
  });

  it("charges before it pops: thickens and heats while still fully opaque", () => {
    const charging = fadeStyle(0.88 * 1000, 1000);
    expect(charging.alpha).toBe(1); // NOT dimming — the tell is width and heat
    expect(charging.widthScale).toBeGreaterThan(1);
    expect(charging.glow).toBeGreaterThan(0);
  });

  it("pops fast at the very end, and is gone by the deadline", () => {
    const popping = fadeStyle(0.97 * 1000, 1000);
    expect(popping.alpha).toBeLessThan(1);
    expect(popping.alpha).toBeGreaterThan(0);
    expect(fadeStyle(1000, 1000).alpha).toBe(0);
    expect(fadeStyle(5000, 1000).alpha).toBe(0);
  });

  it("stretches monotonically all the way out", () => {
    const widths = [0.8, 0.85, 0.9, 0.95, 1.0].map((p) => fadeStyle(p * 1000, 1000).widthScale);
    for (let i = 1; i < widths.length; i++) {
      expect(widths[i]).toBeGreaterThanOrEqual(widths[i - 1]);
    }
  });
});

describe("isFullStyle — the cache key that keeps fading affordable", () => {
  it("is true during the hold, so a fading stroke re-stamps NOTHING for 80% of its life", () => {
    expect(isFullStyle(fadeStyle(0.5 * 1000, 1000))).toBe(true);
    expect(isFullStyle(FULL_STYLE)).toBe(true);
  });

  it("is false once the warp begins — the tile must be rebuilt", () => {
    // The width stretch is why a baked tile cannot simply be blitted: warping
    // thickens the LINE, and scaling a raster moves the geometry instead.
    expect(isFullStyle(fadeStyle(0.9 * 1000, 1000))).toBe(false);
  });
});

describe("crossfadeStyle — the preview's handoff (D3)", () => {
  it("is permanent ink when fadeMs <= 0", () => {
    expect(crossfadeStyle(500, 0)).toEqual(FULL_STYLE);
  });

  it("dissolves monotonically from 1 to 0, softly at both ends", () => {
    const alphas = [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1].map((p) => crossfadeStyle(p * 500, 500).alpha);
    for (let i = 1; i < alphas.length; i++) {
      expect(alphas[i]).toBeLessThanOrEqual(alphas[i - 1]);
    }
    expect(alphas[0]).toBe(1);
    expect(alphas.at(-1)).toBe(0);
    // soft ends: barely moved at 10%, nearly done by 90% — no pop at either edge
    expect(alphas[1]).toBeGreaterThan(0.95);
    expect(alphas[5]).toBeLessThan(0.05);
  });

  it("never warps — so the fading tile is reused as-is, and the fade is free", () => {
    const mid = crossfadeStyle(250, 500);
    expect(mid.widthScale).toBe(1);
    expect(mid.glow).toBe(0);
    expect(isFullStyle(mid)).toBe(true); // alpha applies at blit; no re-bake ever
  });
});

describe("heat", () => {
  it("leaves a colour alone at zero", () => {
    expect(heat("#2b2b33", 0)).toBe("#2b2b33");
  });

  it("pulls toward white", () => {
    expect(heat("#000000", 1)).toBe("rgb(255, 255, 255)");
    expect(heat("#000000", 0.5)).toBe("rgb(128, 128, 128)");
  });

  it("expands #rgb shorthand", () => {
    expect(heat("#000", 1)).toBe("rgb(255, 255, 255)");
  });

  it("leaves anything it cannot parse untouched", () => {
    expect(heat("rebeccapurple", 0.5)).toBe("rebeccapurple");
    expect(heat("rgb(1,2,3)", 0.5)).toBe("rgb(1,2,3)");
  });
});
