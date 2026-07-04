import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyDemoTarget, demoDependencyRange, scaffoldDemo, templateRoot } from "./demo";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aiui-demo-cmd-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("classifyDemoTarget", () => {
  it("treats missing or empty directories as new", () => {
    expect(classifyDemoTarget(join(dir, "nope"))).toBe("new");
    mkdirSync(join(dir, "empty"));
    expect(classifyDemoTarget(join(dir, "empty"))).toBe("new");
  });

  it("recognizes a scaffolded demo by its marker", () => {
    const demo = join(dir, "demo");
    mkdirSync(demo);
    writeFileSync(join(demo, "package.json"), JSON.stringify({ aiui: { demo: true } }));
    expect(classifyDemoTarget(demo)).toBe("existing-demo");
  });

  it("refuses anything else — plain files, unmarked projects", () => {
    const project = join(dir, "project");
    mkdirSync(project);
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "not-ours" }));
    expect(classifyDemoTarget(project)).toBe("occupied");

    writeFileSync(join(dir, "file"), "x");
    expect(classifyDemoTarget(join(dir, "file"))).toBe("occupied");
  });
});

describe("demoDependencyRange", () => {
  it("pins to the release line for real versions, latest for dev builds", () => {
    expect(demoDependencyRange("1.4.0")).toBe("^1.4.0");
    expect(demoDependencyRange("0.0.0+dev")).toBe("latest");
  });
});

describe("scaffoldDemo (against the real shipped template)", () => {
  it("copies the app, restores .gitignore, pins versions, and is re-runnable", () => {
    const template = templateRoot();
    expect(template).toBeDefined();
    const target = join(dir, "scaffold");
    scaffoldDemo(template as string, target);

    // The app shape a user (and the packaging test) relies on.
    for (const file of [
      "package.json",
      "vite.config.ts",
      "index.html",
      "src/main.ts",
      "README.md",
      "CLAUDE.md",
    ]) {
      expect(readFileSync(join(target, file), "utf8").length).toBeGreaterThan(0);
    }
    expect(readFileSync(join(target, ".gitignore"), "utf8")).toContain("node_modules");

    const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf8")) as {
      aiui?: { demo?: boolean };
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.aiui?.demo).toBe(true);
    // Placeholders resolved to a real range (dev build → "latest").
    expect(pkg.dependencies["@habemus-papadum/aiui-dev-overlay"]).not.toContain("__AIUI");
    expect(pkg.devDependencies["@habemus-papadum/aiui"]).not.toContain("__AIUI");

    // The marker makes a second run a continuation, not a re-scaffold.
    expect(classifyDemoTarget(target)).toBe("existing-demo");
  });
});
