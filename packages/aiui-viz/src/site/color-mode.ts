/**
 * color-mode.ts — the reactive system color mode, once per page.
 *
 * Notebook pages follow `prefers-color-scheme` with no toggle (design-choices
 * §8): CSS design tokens carry everything the stylesheet can reach; this
 * signal supplies the mode for colors that must be *literal* values — chart
 * palettes, SVG strokes, Plot cosmetics — so those redraw on a live system
 * theme change too. Apps define their own per-mode palettes keyed by
 * {@link ColorMode} (see the demo's src/site/theme.ts for the worked example);
 * this module owns only the mode machinery.
 *
 * The signal + its `matchMedia` listener live in the durable registry: theme
 * modules are imported by nearly every component, so an HMR re-evaluation must
 * not stack a second listener or reset the mode mid-session.
 */
import { type Accessor, createSignal } from "solid-js";
import { durable } from "../durable";

export type ColorMode = "dark" | "light";

/** Non-browser realms (node test runs, jsdom without matchMedia) get a static
 * default instead of a throw — the durable registry itself lives on `window`,
 * so the guard must come BEFORE the durable call, not just around matchMedia. */
function makeModeBox(): { get: Accessor<ColorMode> } {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    const [get] = createSignal<ColorMode>("dark");
    return { get };
  }
  return durable("aiui:color-mode", () => {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const [get, set] = createSignal<ColorMode>(mql.matches ? "dark" : "light");
    mql.addEventListener("change", (e) => set(e.matches ? "dark" : "light"));
    return { get, set };
  });
}

const modeBox = makeModeBox();

/**
 * The live system color mode. Reading it in a chart's options memo re-renders
 * that chart on a theme change.
 */
export const colorMode: Accessor<ColorMode> = modeBox.get;

export const isDark = (): boolean => colorMode() === "dark";
