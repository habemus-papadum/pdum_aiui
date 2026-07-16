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

  it("refuses anything else — plain files, unmarked projects, aiui demos", () => {
    const project = join(dir, "project");
    mkdirSync(project);
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "not-ours" }));
    expect(classifyTarget(project)).toBe("occupied");

    const demo = join(dir, "demo");
    mkdirSync(demo);
    writeFileSync(join(demo, "package.json"), JSON.stringify({ aiui: { demo: true } }));
    expect(classifyTarget(demo)).toBe("occupied");

    writeFileSync(join(dir, "file"), "x");
    expect(classifyTarget(join(dir, "file"))).toBe("occupied");
  });
});

describe("dependencyRange", () => {
  it("pins to the release line for real versions, latest for dev builds", () => {
    expect(dependencyRange("1.4.0")).toBe("^1.4.0");
    expect(dependencyRange("0.0.0+dev")).toBe("latest");
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
    scaffoldApp(template as string, target, "0.0.0+dev");

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
    // Placeholders resolved to a real range (dev build → "latest").
    expect(pkg.dependencies["@habemus-papadum/aiui-viz"]).toBe("latest");
    expect(pkg.dependencies["@habemus-papadum/aiui-source-processor"]).toBe("latest");
    expect(pkg.devDependencies["@habemus-papadum/aiui"]).toBe("latest");

    // The marker makes a second run a continuation, not a re-scaffold.
    expect(classifyTarget(target)).toBe("existing-scaffold");
  });

  it("pins release builds to the release line", () => {
    const target = join(dir, "pinned");
    scaffoldApp(templateRoot() as string, target, "1.4.0");
    const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies["@habemus-papadum/aiui-viz"]).toBe("^1.4.0");
  });

  it("honors an explicit range — what `pnpm new-demo` uses for workspace links", () => {
    const target = join(dir, "in-repo");
    scaffoldApp(templateRoot() as string, target, "1.4.0", "workspace:^");
    const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.dependencies["@habemus-papadum/aiui-viz"]).toBe("workspace:^");
    expect(pkg.dependencies["@habemus-papadum/aiui-source-processor"]).toBe("workspace:^");
    expect(pkg.devDependencies["@habemus-papadum/aiui"]).toBe("workspace:^");
  });
});
