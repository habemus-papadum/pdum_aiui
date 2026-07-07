import { describe, expect, it } from "vitest";
import { buildProgram } from "./program";

describe("aiui cli", () => {
  it("is named aiui", () => {
    expect(buildProgram().name()).toBe("aiui");
  });

  it("registers the browser, chrome, claude, clean, config, demo, lsp, mcp, open, paint, setup-lsp, and vite subcommands", () => {
    const names = buildProgram()
      .commands.map((cmd) => cmd.name())
      .sort();
    expect(names).toEqual([
      "browser",
      "chrome",
      "claude",
      "clean",
      "config",
      "demo",
      "lsp",
      "mcp",
      "open",
      "paint",
      "setup-lsp",
      "vite",
    ]);
  });

  it("gives aiui config its tui, show, get, set, and unset subcommands", () => {
    const config = buildProgram().commands.find((cmd) => cmd.name() === "config");
    const names = config?.commands.map((cmd) => cmd.name()).sort();
    expect(names).toEqual(["get", "set", "show", "tui", "unset"]);
  });
});
