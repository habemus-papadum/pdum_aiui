import { describe, expect, it } from "vitest";
import { buildProgram } from "./program";

describe("aiui-claude-channel cli", () => {
  it("is named aiui-claude-channel", () => {
    expect(buildProgram().name()).toBe("aiui-claude-channel");
  });

  it("registers the config, mcp, and quick subcommands", () => {
    const names = buildProgram()
      .commands.map((cmd) => cmd.name())
      .sort();
    expect(names).toEqual(["config", "mcp", "quick"]);
  });
});
