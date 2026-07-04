import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import { packageRoot, resolvePackageCli } from "./resolve-cli";

const CHANNEL_PKG = "@habemus-papadum/aiui-claude-channel";

describe("packageRoot", () => {
  it("resolves a dependency's root from its package.json (no build required)", () => {
    const root = packageRoot(CHANNEL_PKG);
    expect(isAbsolute(root)).toBe(true);
    expect(existsSync(join(root, "package.json"))).toBe(true);
  });
});

describe("resolvePackageCli", () => {
  it("runs the TS source via tsx in a dev checkout", () => {
    // The tests run against the workspace, where the package still has its src/.
    const { command, args } = resolvePackageCli(CHANNEL_PKG);
    expect(command).toBe(process.execPath);
    expect(args.slice(0, 2)).toEqual(["--import", "tsx"]);
    expect(args[2].endsWith("src/cli.ts")).toBe(true);
    expect(existsSync(args[2])).toBe(true);
  });
});
