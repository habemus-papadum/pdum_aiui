/**
 * The design values, pinned: every literal is a real color, the hex twins of
 * the CSS ladder are the mixes tokens.css declares, and the contrasts
 * DESIGN.md claims hold — ink and accent on the paper, series and plot ink on
 * a raised panel, status colors on the paper. A typo here silently
 * un-validates every chart, so the numbers are checked, not trusted.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CHART, chart, FONTS, PLOT, plot, plotStyle, TOKENS } from "./index";

const HEX = /^#[0-9a-f]{6}$/;

function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** `color-mix(in srgb, ink P%, surface)` — straight sRGB interpolation. */
function mix(ink: string, surface: string, pct: number): string {
  const a = rgb(ink);
  const b = rgb(surface);
  const c = a.map((v, i) => Math.round((v * pct) / 100 + (b[i] * (100 - pct)) / 100));
  return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

describe("aiui-design theme", () => {
  it("every literal is a six-digit hex color", () => {
    for (const value of [
      ...Object.values(TOKENS),
      ...Object.values(CHART),
      ...Object.values(PLOT),
    ]) {
      expect(value).toMatch(HEX);
    }
  });

  it("the hex ladder is the CSS ladder (same mixes as tokens.css)", () => {
    const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
    const rung = (name: string): number => {
      const m = css.match(new RegExp(`--${name}: color-mix\\(in srgb, var\\(--ink\\) (\\d+)%`));
      if (!m) throw new Error(`no mixed rung --${name} in tokens.css`);
      return Number(m[1]);
    };
    expect(css).toContain(`--surface: ${TOKENS.surface}`);
    expect(css).toContain(`--ink: ${TOKENS.ink}`);
    expect(css).toContain(`--accent: ${TOKENS.accent}`);
    expect(css).toContain(`--plate: ${TOKENS.plate}`);
    expect(mix(TOKENS.ink, TOKENS.surface, rung("surface-raised"))).toBe(TOKENS.surfaceRaised);
    expect(mix(TOKENS.ink, TOKENS.surface, rung("ink-muted"))).toBe(TOKENS.inkMuted);
    expect(mix(TOKENS.ink, TOKENS.surface, rung("muted"))).toBe(TOKENS.muted);
    expect(mix(TOKENS.ink, TOKENS.surface, rung("hairline"))).toBe(TOKENS.hairline);
    expect(mix(TOKENS.ink, TOKENS.surface, rung("ghost"))).toBe(TOKENS.ghost);
  });

  it("text contrasts hold on the paper (AAA ink, AA accent and status)", () => {
    expect(contrast(TOKENS.ink, TOKENS.surface)).toBeGreaterThanOrEqual(7);
    expect(contrast(TOKENS.inkMuted, TOKENS.surface)).toBeGreaterThanOrEqual(3);
    expect(contrast(TOKENS.accent, TOKENS.surface)).toBeGreaterThanOrEqual(4.5);
    for (const status of [TOKENS.ok, TOKENS.warn, TOKENS.alarm]) {
      expect(contrast(status, TOKENS.surface)).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(TOKENS.plateInk, TOKENS.plate)).toBeGreaterThanOrEqual(10);
  });

  it("series and plot ink clear a raised panel; no series is the accent's hue", () => {
    for (const series of Object.values(CHART)) {
      expect(contrast(series, TOKENS.surfaceRaised)).toBeGreaterThanOrEqual(3);
    }
    expect(contrast(PLOT.text, TOKENS.surfaceRaised)).toBeGreaterThanOrEqual(4);
    expect(PLOT.strong).toBe(TOKENS.ink);
    expect(PLOT.rule).toBe(TOKENS.hairline);
    // the accent is purple-indigo: red and blue high, green low — no series may be
    const [ar, , ab] = rgb(TOKENS.accent);
    for (const series of Object.values(CHART)) {
      const [r, g, b] = rgb(series);
      const accentLike = r > g && b > g && Math.abs(r - ar) < 60 && Math.abs(b - ab) < 60;
      expect(accentLike).toBe(false);
    }
  });

  it("accessors are callable and plotStyle is transparent panel ink in the label face", () => {
    expect(chart()).toBe(CHART);
    expect(plot()).toBe(PLOT);
    const s = plotStyle();
    expect(s.background).toBe("transparent");
    expect(s.color).toBe(PLOT.text);
    expect(s.fontFamily).toBe(FONTS.sans);
  });
});
