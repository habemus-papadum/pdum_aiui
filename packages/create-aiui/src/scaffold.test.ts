import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appNameFrom,
  classifyTarget,
  dependencyRange,
  packageManager,
  scaffoldApp,
  templateRoot,
} from "./scaffold";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "create-aiui-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("classifyTarget", () => {
  it("treats missing or empty directories as new", () => {
    expect(classifyTarget(join(dir, "nope"))).toBe("new");
    mkdirSync(join(dir, "empty"));
    expect(classifyTarget(join(dir, "empty"))).toBe("new");
  });

  it("recognizes a previous scaffold by its marker", () => {
    const app = join(dir, "app");
    mkdirSync(app);
    writeFileSync(join(app, "package.json"), JSON.stringify({ aiui: { scaffold: true } }));
    expect(classifyTarget(app)).toBe("existing-scaffold");
  });

  it("refuses anything else — plain files, unmarked projects, other aiui markers", () => {
    const project = join(dir, "project");
    mkdirSync(project);
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "not-ours" }));
    expect(classifyTarget(project)).toBe("occupied");

    // An `aiui` key WITHOUT `scaffold: true` is still occupied — only our own
    // marker counts, not the key's mere presence.
    const marked = join(dir, "marked");
    mkdirSync(marked);
    writeFileSync(join(marked, "package.json"), JSON.stringify({ aiui: { other: true } }));
    expect(classifyTarget(marked)).toBe("occupied");

    writeFileSync(join(dir, "file"), "x");
    expect(classifyTarget(join(dir, "file"))).toBe("occupied");
  });
});

describe("dependencyRange", () => {
  it("pins each package to its own baked release line, latest when none is baked", () => {
    const baked = { "@x/a": "1.4.0+dev", "@x/b": "0.9.2", "@x/c": "0.0.0+dev" };
    expect(dependencyRange("@x/a", baked)).toBe("^1.4.0");
    expect(dependencyRange("@x/b", baked)).toBe("^0.9.2");
    expect(dependencyRange("@x/c", baked)).toBe("latest"); // never released
    expect(dependencyRange("@x/d", baked)).toBe("latest"); // not baked
    expect(dependencyRange("@x/a", {})).toBe("latest"); // source checkout, nothing baked
  });
});

describe("appNameFrom", () => {
  it("slugifies the target basename into a valid package name", () => {
    expect(appNameFrom("/tmp/My Cool App!")).toBe("my-cool-app");
    expect(appNameFrom("/tmp/spectra-2")).toBe("spectra-2");
    expect(appNameFrom("/tmp/---")).toBe("aiui-app");
  });
});

describe("packageManager", () => {
  it("follows the invoking package manager, defaulting to npm", () => {
    expect(packageManager("pnpm/11.9.0 npm/? node/v24.0.0 darwin arm64")).toBe("pnpm");
    expect(packageManager("npm/11.0.0 node/v24.0.0 darwin arm64")).toBe("npm");
    // No user agent at all (a directly-run bin) falls back to npm.
    expect(packageManager("")).toBe("npm");
  });
});

describe("scaffoldApp (against the real shipped template)", () => {
  it("copies the app, restores dot-files, resolves tokens, and is re-runnable", () => {
    const template = templateRoot();
    expect(template).toBeDefined();
    const target = join(dir, "my-viz-app");
    scaffoldApp(template as string, target);

    // The app shape a user (and the packaging test) relies on.
    for (const file of [
      "package.json",
      "vite.config.ts",
      "vitest.config.ts",
      "tsconfig.json",
      "index.html",
      "src/main.tsx",
      "src/styles.css",
      "src/model/store.ts",
      "src/model/rose.ts",
      "src/model/rose.test.ts",
      "src/model/scenery.ts",
      "src/model/scenery.test.ts",
      "src/model/graph.ts",
      "src/ui/App.tsx",
      "src/ui/Banner.tsx",
      "src/ui/Picture.tsx",
      "src/ui/Controls.tsx",
      "README.md",
      "CLAUDE.md",
    ]) {
      expect(readFileSync(join(target, file), "utf8").length).toBeGreaterThan(0);
    }
    // npm strips dot-paths from published tarballs; the scaffold restores them.
    expect(readFileSync(join(target, ".gitignore"), "utf8")).toContain("node_modules");
    expect(readFileSync(join(target, ".envrc"), "utf8")).toContain("layout node");

    const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf8")) as {
      name: string;
      aiui?: { scaffold?: boolean };
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.name).toBe("my-viz-app");
    expect(pkg.aiui?.scaffold).toBe(true);
    // Placeholders resolved to a real range (nothing baked under the test runner → "latest").
    expect(pkg.dependencies["@habemus-papadum/aiui-viz"]).toBe("latest");
    expect(pkg.dependencies["@habemus-papadum/aiui-source-processor"]).toBe("latest");

    // The marker makes a second run a continuation, not a re-scaffold.
    expect(classifyTarget(target)).toBe("existing-scaffold");
  });

  it("pins a release build to each package's own release line", () => {
    const target = join(dir, "pinned");
    const baked = {
      "@habemus-papadum/aiui-viz": "1.4.0+dev",
      "@habemus-papadum/aiui-source-processor": "1.2.0+dev",
      "@habemus-papadum/aiui-design": "0.9.3",
    };
    scaffoldApp(templateRoot() as string, target, (name) => dependencyRange(name, baked));
    const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies["@habemus-papadum/aiui-viz"]).toBe("^1.4.0");
    expect(pkg.dependencies["@habemus-papadum/aiui-source-processor"]).toBe("^1.2.0");
    expect(pkg.dependencies["@habemus-papadum/aiui-design"]).toBe("^0.9.3");
    expect(pkg.dependencies["solid-js"]).toBe("2.0.0-rc.13"); // untouched: no token
  });

  it("honors an explicit range — what `pnpm new-demo` uses for workspace floors", () => {
    const target = join(dir, "in-repo");
    const floors: Record<string, string> = {
      "@habemus-papadum/aiui-viz": "workspace:>=0.24.0",
      "@habemus-papadum/aiui-source-processor": "workspace:>=0.24.0",
      "@habemus-papadum/aiui-design": "workspace:>=0.0.0",
    };
    scaffoldApp(templateRoot() as string, target, (name) => floors[name] ?? "latest");
    const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.dependencies["@habemus-papadum/aiui-viz"]).toBe("workspace:>=0.24.0");
    expect(pkg.dependencies["@habemus-papadum/aiui-design"]).toBe("workspace:>=0.0.0");

    // One string applies to every token.
    const flat = join(dir, "flat");
    scaffoldApp(templateRoot() as string, flat, "workspace:*");
    const flatPkg = JSON.parse(readFileSync(join(flat, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(flatPkg.dependencies["@habemus-papadum/aiui-source-processor"]).toBe("workspace:*");
  });
});
