/**
 * Pin the theme module's invariants: the palette values are real hex colors
 * (the dataviz-validated literals — a typo here silently un-validates every
 * chart), and the mode surface stays shaped like the reactive version the
 * demos' option memos were written against.
 */
import { describe, expect, it } from "vitest";
import { chart, isDark, mode, plot, plotStyle } from "./theme";

const HEX = /^#[0-9a-f]{6}$/;

describe("journal theme", () => {
  it("mode is constant dark, as a callable (memo-shaped) surface", () => {
    expect(mode()).toBe("dark");
    expect(isDark()).toBe(true);
  });

  it("chart palette and plot cosmetics are 6-digit hex literals", () => {
    for (const value of [...Object.values(chart()), ...Object.values(plot())]) {
      expect(value).toMatch(HEX);
    }
  });

  it("plotStyle is transparent-background panel ink", () => {
    const s = plotStyle();
    expect(s.background).toBe("transparent");
    expect(s.color).toBe(plot().text);
  });
});
