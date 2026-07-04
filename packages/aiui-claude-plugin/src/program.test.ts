import { describe, expect, it } from "vitest";
import { buildProgram } from "./program";

describe("aiui-claude-plugin cli", () => {
  it("is named aiui-claude-plugin", () => {
    expect(buildProgram().name()).toBe("aiui-claude-plugin");
  });

  it("registers the path and list subcommands", () => {
    const names = buildProgram()
      .commands.map((cmd) => cmd.name())
      .sort();
    expect(names).toEqual(["list", "path"]);
  });
});
