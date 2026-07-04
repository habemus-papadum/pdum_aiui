import { describe, expect, it } from "vitest";
import { buildProgram } from "./program";

describe("aiui cli", () => {
  it("is named aiui", () => {
    expect(buildProgram().name()).toBe("aiui");
  });

  it("registers the browser, chrome, claude, demo, mcp, open, and vite subcommands", () => {
    const names = buildProgram()
      .commands.map((cmd) => cmd.name())
      .sort();
    expect(names).toEqual(["browser", "chrome", "claude", "demo", "mcp", "open", "vite"]);
  });
});
