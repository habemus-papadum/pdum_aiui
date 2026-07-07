import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { packageFromSource, packageRoot, runningFromSource } from "./provenance";

const temps: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aiui-provenance-"));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of temps.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

describe("runningFromSource", () => {
  it("is true when the package dir carries a src/ folder (dev checkout)", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "src"));
    expect(runningFromSource(dir)).toBe(true);
  });

  it("is false when only dist/ is present (installed tarball)", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "dist"));
    expect(runningFromSource(dir)).toBe(false);
  });
});

describe("packageRoot / packageFromSource", () => {
  it("resolves a workspace package to a dir with its package.json", () => {
    const root = packageRoot("@habemus-papadum/aiui-util");
    expect(root).toMatch(/aiui-util$/);
  });

  it("reports this workspace package as a source checkout", () => {
    // We're running from src/ in the monorepo.
    expect(packageFromSource("@habemus-papadum/aiui-util")).toBe(true);
  });

  it("throws for an unresolvable package", () => {
    expect(() => packageRoot("@habemus-papadum/does-not-exist-xyz")).toThrow(/could not locate/);
  });
});
