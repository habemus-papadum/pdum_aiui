import { isAbsolute } from "node:path";
import { describe, expect, it } from "vitest";
import { channelCliPath } from "./cli-path";

describe("channelCliPath", () => {
  it("returns an absolute path to the built cli.js", () => {
    const p = channelCliPath();
    expect(isAbsolute(p)).toBe(true);
    expect(p.endsWith("/dist/cli.js") || p.endsWith("\\dist\\cli.js")).toBe(true);
  });
});
