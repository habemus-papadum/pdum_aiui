import { describe, expect, it } from "vitest";
import { buildProgram } from "./program";

describe("aiui-claude-channel cli", () => {
  it("is named aiui-claude-channel", () => {
    expect(buildProgram().name()).toBe("aiui-claude-channel");
  });

  it("registers the mcp, quick, and serve subcommands", () => {
    const names = buildProgram()
      .commands.map((cmd) => cmd.name())
      .sort();
    expect(names).toEqual(["mcp", "quick", "serve"]);
  });

  it("serve declares --tag, --name, --record, --port, --bind, and --mode", () => {
    const serve = buildProgram().commands.find((cmd) => cmd.name() === "serve");
    const flags = serve?.options.map((option) => option.long).sort();
    expect(flags).toEqual(["--bind", "--mode", "--name", "--port", "--record", "--tag"]);
  });

  it("mcp declares --tag, --launch-info, --bind, --mode, and --no-page-tools-notify", () => {
    const mcp = buildProgram().commands.find((cmd) => cmd.name() === "mcp");
    const flags = mcp?.options.map((option) => option.long).sort();
    expect(flags).toEqual(["--bind", "--launch-info", "--mode", "--no-page-tools-notify", "--tag"]);
  });
});
