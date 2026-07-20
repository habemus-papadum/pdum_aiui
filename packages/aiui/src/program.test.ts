import { describe, expect, it } from "vitest";
import { buildProgram } from "./program";

describe("aiui cli", () => {
  it("is named aiui", () => {
    expect(buildProgram().name()).toBe("aiui");
  });

  it("registers the browser, chrome, claude, clean, config, debug, env, extension, mcp, native-host, open, pencil, remote, and vite subcommands", () => {
    const names = buildProgram()
      .commands.map((cmd) => cmd.name())
      .sort();
    expect(names).toEqual([
      "browser",
      "chrome",
      "claude",
      "clean",
      "config",
      "debug",
      "env",
      "extension",
      "mcp",
      "native-host",
      "open",
      "pencil",
      "remote",
      "vite",
    ]);
  });

  // Scaffolding lives in create-aiui (`npm create @habemus-papadum/aiui`), not
  // here — one starter template, not two.
  it("no longer registers a demo scaffolder", () => {
    expect(buildProgram().commands.map((cmd) => cmd.name())).not.toContain("demo");
  });

  it("gives aiui config its tui, show, get, set, set-dsp, and unset subcommands", () => {
    const config = buildProgram().commands.find((cmd) => cmd.name() === "config");
    const names = config?.commands.map((cmd) => cmd.name()).sort();
    expect(names).toEqual(["get", "set", "set-dsp", "show", "tui", "unset"]);
  });
});
