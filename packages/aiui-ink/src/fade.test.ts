import { describe, expect, it } from "vitest";
import { FULL_STYLE, fadeStyle, heat, INK_CHARGE, INK_HOLD } from "./fade";

describe("fadeStyle (the warp curve: hold → charge → pop)", () => {
  const FADE = 6000;

  it("is permanent at fadeMs <= 0", () => {
    expect(fadeStyle(999_999, 0)).toEqual(FULL_STYLE);
    expect(fadeStyle(999_999, -1)).toEqual(FULL_STYLE);
  });

  it("does nothing for the first 80% of life", () => {
    for (const p of [0, 0.4, INK_HOLD - 0.01]) {
      expect(fadeStyle(p * FADE, FADE)).toEqual(FULL_STYLE);
    }
  });

  it("charges fully opaque — thicker and hotter, no dimming", () => {
    const midCharge = (INK_HOLD + (1 - INK_HOLD) * INK_CHARGE * 0.5) * FADE;
    const style = fadeStyle(midCharge, FADE);
    expect(style.alpha).toBe(1);
    expect(style.widthScale).toBeGreaterThan(1);
    expect(style.glow).toBeGreaterThan(0);
    expect(style.glow).toBeLessThanOrEqual(1);
  });

  it("pops at the end: alpha collapses in the final instants, width stretches on", () => {
    const midPop = (INK_HOLD + (1 - INK_HOLD) * (INK_CHARGE + (1 - INK_CHARGE) * 0.5)) * FADE;
    const style = fadeStyle(midPop, FADE);
    expect(style.alpha).toBeLessThan(1);
    expect(style.alpha).toBeGreaterThan(0);
    const done = fadeStyle(FADE, FADE);
    expect(done.alpha).toBe(0);
    expect(done.widthScale).toBeGreaterThan(style.widthScale);
  });
});

describe("heat", () => {
  it("pulls hex colours toward white and leaves the unparseable alone", () => {
    expect(heat("#000000", 1)).toBe("rgb(255, 255, 255)");
    expect(heat("#ff5c87", 0)).toBe("#ff5c87");
    expect(heat("tomato", 0.5)).toBe("tomato");
    expect(heat("#08f", 0.5)).toBe(heat("#0088ff", 0.5)); // 3-digit expands
  });
});
