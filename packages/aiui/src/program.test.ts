import { describe, expect, it } from "vitest";
import { buildProgram } from "./program";

describe("aiui cli", () => {
  it("is named aiui", () => {
    expect(buildProgram().name()).toBe("aiui");
  });

  it("registers the claude and vite subcommands", () => {
    const names = buildProgram()
      .commands.map((cmd) => cmd.name())
      .sort();
    expect(names).toEqual(["claude", "vite"]);
  });
});
