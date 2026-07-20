import { describe, expect, it } from "vitest";
import { buildProgram } from "./program";

describe("aiui cli", () => {
  it("is named aiui", () => {
    expect(buildProgram().name()).toBe("aiui");
  });

  it("registers exactly the consolidated command surface", () => {
    const names = buildProgram()
      .commands.map((cmd) => cmd.name())
      .sort();
    expect(names).toEqual([
      "chrome",
      "claude",
      "clean",
      "config",
      "debug",
      "extension",
      "mcp",
      "open",
      "profile",
      "remote",
    ]);
  });

  // Scaffolding lives in create-aiui (`npm create @habemus-papadum/aiui`), not
  // here — one starter template, not two. And the retired commands stay gone:
  // vite (apps run plain `vite`), env (direnv), pencil (the console shows the
  // URL), browser (`aiui open` finds-or-starts).
  it("registers none of the retired commands", () => {
    const names = buildProgram().commands.map((cmd) => cmd.name());
    for (const retired of ["demo", "vite", "env", "pencil", "browser", "native-host"]) {
      expect(names).not.toContain(retired);
    }
  });

  it("gives aiui config its tui, show, get, set, set-dsp, and unset subcommands", () => {
    const config = buildProgram().commands.find((cmd) => cmd.name() === "config");
    const names = config?.commands.map((cmd) => cmd.name()).sort();
    expect(names).toEqual(["get", "set", "set-dsp", "show", "tui", "unset"]);
  });
});
