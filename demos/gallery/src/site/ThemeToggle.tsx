/**
 * ThemeToggle.tsx — the demo's light/dark switch.
 *
 * This app opts out of the library's system-following color mode (see
 * site/theme.ts): it starts light and lets the reader flip to dark. A small
 * fixed pill in the bottom-left corner (the aiui intent tool owns bottom-right),
 * mounted once per page. The glyph shows the mode you'll switch *to* — a moon
 * while light, a sun while dark — and the choice persists across the site.
 */
import { Show } from "solid-js";
import { isDark, toggleMode } from "./theme";

export function ThemeToggle() {
  return (
    <button
      type="button"
      class="theme-toggle"
      onClick={() => toggleMode()}
      aria-label={isDark() ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark() ? "Switch to light mode" : "Switch to dark mode"}
    >
      <Show when={isDark()} fallback={<MoonIcon />}>
        <SunIcon />
      </Show>
      <span class="theme-toggle-label">{isDark() ? "light" : "dark"}</span>
    </button>
  );
}

function MoonIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}
