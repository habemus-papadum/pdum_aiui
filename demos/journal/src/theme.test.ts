/**
 * Pin the theme module's invariants: BOTH modes' palette values are real hex
 * colors (the dataviz-validated literals — a typo here silently un-validates
 * every chart), and the mode surface stays shaped like the reactive accessor
 * the demos' option memos were written against. Under node (no matchMedia)
 * the mode is the static dark default — the reactive path is the browser's.
 */
import { describe, expect, it } from "vitest";
import { CHART_PALETTES, chart, isDark, mode, PLOT_COSMETICS, plot, plotStyle } from "./theme";

const HEX = /^#[0-9a-f]{6}$/;

describe("journal theme", () => {
  it("mode is a callable (memo-shaped) surface, coherent with isDark", () => {
    const m = mode();
    expect(m === "dark" || m === "light").toBe(true);
    expect(isDark()).toBe(m === "dark");
    // No matchMedia in this realm: the guard's static default is dark, and
    // the accessors must agree with the table for that mode.
    expect(chart()).toEqual(CHART_PALETTES[m]);
    expect(plot()).toEqual(PLOT_COSMETICS[m]);
  });

  it("chart palettes and plot cosmetics are 6-digit hex literals in BOTH modes", () => {
    for (const m of ["dark", "light"] as const) {
      for (const value of [
        ...Object.values(CHART_PALETTES[m]),
        ...Object.values(PLOT_COSMETICS[m]),
      ]) {
        expect(value).toMatch(HEX);
      }
    }
  });

  it("the two modes are genuinely distinct palettes, not an automatic flip", () => {
    expect(CHART_PALETTES.dark).not.toEqual(CHART_PALETTES.light);
    expect(PLOT_COSMETICS.dark).not.toEqual(PLOT_COSMETICS.light);
  });

  it("plotStyle is transparent-background panel ink", () => {
    const s = plotStyle();
    expect(s.background).toBe("transparent");
    expect(s.color).toBe(plot().text);
  });
});
