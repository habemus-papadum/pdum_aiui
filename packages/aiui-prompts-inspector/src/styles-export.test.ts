import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { INSPECTOR_STYLES } from "./styles.ts";

const css = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");

it("the string export is the stylesheets' text (run `pnpm gen:styles` after editing CSS)", () => {
  expect(INSPECTOR_STYLES.base).toBe(css("./style.css"));
  expect(INSPECTOR_STYLES.themes.aiui).toBe(css("./themes/aiui.css"));
  expect(INSPECTOR_STYLES.themes.terminal).toBe(css("./themes/terminal.css"));
  expect(INSPECTOR_STYLES.base).toContain(".prompt-inspector");
});
