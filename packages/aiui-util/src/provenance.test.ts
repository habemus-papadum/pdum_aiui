import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ownPackageRoot, packageFromSource, packageRoot, runningFromSource } from "./provenance.ts";

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
  it("is true when the manifest's main points into src/ (dev checkout)", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ main: "./src/index.ts" }));
    expect(runningFromSource(dir)).toBe(true);
  });

  it("is false when the manifest's main points at dist/ (installed tarball)", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ main: "./dist/index.js" }));
    expect(runningFromSource(dir)).toBe(false);
  });

  it("is false for an installed tarball even when src/ ships alongside dist/", () => {
    // Published packages ship src/ for sourcemap back-references; the swap of
    // publishConfig's dist mapping into `main` is what marks them installed.
    const dir = tempDir();
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ main: "./dist/index.js" }));
    expect(runningFromSource(dir)).toBe(false);
  });

  it("is false for a directory without a package.json", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "src"));
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

describe("ownPackageRoot", () => {
  it(
    "a workspace module finds ITSELF by upward walk, even though pnpm's " +
      "strict layout hides it from every by-name chain",
    () => {
      // Exactly the vantage that broke live (2026-08-24): a workspace package
      // asking about itself from its own real source path.
      const root = ownPackageRoot({
        importMetaUrl: import.meta.url,
        packageName: "@habemus-papadum/aiui-util",
      });
      expect(root).toMatch(/aiui-util$/);
      expect(runningFromSource(root ?? "")).toBe(true);
    },
  );

  it(
    "the name guard keeps a foreign vantage honest — nearest manifest with " +
      "the WRONG name is skipped, not reported",
    () => {
      // A bundled config's vantage: the module's URL sits in some consumer
      // directory whose own package.json is the nearest one.
      const dir = tempDir();
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "some-consumer-app" }));
      const root = ownPackageRoot({
        importMetaUrl: pathToFileURL(join(dir, "bundle.mjs")).href,
        packageName: "@habemus-papadum/nowhere-to-be-found",
      });
      expect(root).toBeUndefined();
    },
  );

  it("an unresolvable vantage answers undefined, never a throw", () => {
    const root = ownPackageRoot({
      importMetaUrl: pathToFileURL(join(tmpdir(), "no-such-dir-xyz", "m.mjs")).href,
      packageName: "@habemus-papadum/does-not-exist-xyz",
    });
    expect(root).toBeUndefined();
  });
});
