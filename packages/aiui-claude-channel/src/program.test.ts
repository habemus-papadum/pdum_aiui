import { describe, expect, it } from "vitest";
import { buildProgram } from "./program";

describe("aiui-claude-channel cli", () => {
  it("is named aiui-claude-channel", () => {
    expect(buildProgram().name()).toBe("aiui-claude-channel");
  });

  it("registers the config, mcp, quick, and serve subcommands", () => {
    const names = buildProgram()
      .commands.map((cmd) => cmd.name())
      .sort();
    expect(names).toEqual(["config", "mcp", "quick", "serve"]);
  });

  it("serve declares --tag, --name, --record, --port, --sidecars, and --bind", () => {
    const serve = buildProgram().commands.find((cmd) => cmd.name() === "serve");
    const flags = serve?.options.map((option) => option.long).sort();
    expect(flags).toEqual(["--bind", "--name", "--port", "--record", "--sidecars", "--tag"]);
  });

  it("mcp declares --tag, --launch-info, --sidecars, --bind, and --no-page-tools-notify", () => {
    const mcp = buildProgram().commands.find((cmd) => cmd.name() === "mcp");
    const flags = mcp?.options.map((option) => option.long).sort();
    expect(flags).toEqual([
      "--bind",
      "--launch-info",
      "--no-page-tools-notify",
      "--sidecars",
      "--tag",
    ]);
  });
});
