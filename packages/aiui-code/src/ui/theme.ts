/**
 * theme.ts — follow the system color mode (no toggle), and keep Monaco's theme
 * in lockstep. `colorMode` is a reactive signal literal-color consumers read;
 * the tokens themselves live in styles.css keyed on `:root[data-theme]`.
 */
import { createSignal } from "solid-js";
import { reader } from "../model/store";

export type ColorMode = "light" | "dark";

const [colorMode, setColorMode] = createSignal<ColorMode>(current());

export { colorMode };

function current(): ColorMode {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

/** Apply the system color mode now and follow changes. Returns a disposer that
 * removes the media-query listener (a re-mount must not stack them). */
export function initSystemTheme(): () => void {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () => {
    const mode: ColorMode = mq.matches ? "dark" : "light";
    document.documentElement.dataset.theme = mode;
    setColorMode(mode);
    reader.setColorMode(mode);
  };
  apply();
  mq.addEventListener("change", apply);
  return () => mq.removeEventListener("change", apply);
}
