import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CleanRoots, formatBytes, planCleanTargets, resolveDeletions } from "./clean";

const roots: CleanRoots = {
  project: "/proj/.aiui-cache",
  user: "/home/.cache/aiui",
  browsers: ["/home/.cache/aiui/chromium", "/home/.cache/aiui/chrome"],
};

describe("planCleanTargets", () => {
  it("removes both roots by default, user cache wholesale", () => {
    const targets = planCleanTargets({}, roots);
    expect(targets.map((t) => t.path)).toEqual([roots.project, roots.user]);
    expect(targets.every((t) => t.keep === undefined)).toBe(true);
  });

  it("--keep-browser spares only the managed-browser dirs inside the user cache", () => {
    const targets = planCleanTargets({ keepBrowser: true }, roots);
    expect(targets.map((t) => t.path)).toEqual([roots.project, roots.user]);
    // The project cache is still wiped entirely; only the user target keeps them.
    expect(targets.find((t) => t.path === roots.project)?.keep).toBeUndefined();
    expect(targets.find((t) => t.path === roots.user)?.keep).toEqual(roots.browsers);
  });

  it("--project-only / --user-only narrow the scope to one root", () => {
    expect(planCleanTargets({ projectOnly: true }, roots).map((t) => t.path)).toEqual([
      roots.project,
    ]);
    expect(planCleanTargets({ userOnly: true }, roots).map((t) => t.path)).toEqual([roots.user]);
  });
});

describe("resolveDeletions", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aiui-clean-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("targets the whole path when there is no keep list", () => {
    const cache = join(dir, ".aiui-cache");
    mkdirSync(cache);
    expect(resolveDeletions({ label: "project", path: cache })).toEqual([cache]);
  });

  it("returns nothing for a missing path (so an empty root drops out of the plan)", () => {
    expect(resolveDeletions({ label: "gone", path: join(dir, "nope") })).toEqual([]);
  });

  it("keeps the browser dir and targets every other child", () => {
    const user = join(dir, "aiui");
    mkdirSync(user);
    mkdirSync(join(user, "chrome"));
    mkdirSync(join(user, "mcp"));
    writeFileSync(join(user, "config.json"), "{}");

    const deletions = resolveDeletions({
      label: "user",
      path: user,
      keep: [join(user, "chrome")],
    }).sort();

    expect(deletions).toEqual([resolve(user, "config.json"), resolve(user, "mcp")].sort());
  });
});

describe("formatBytes", () => {
  it("uses binary units, one decimal above a kilobyte", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(346 * 1024 * 1024)).toBe("346.0 MB");
    expect(formatBytes(2 * 1024 ** 3)).toBe("2.0 GB");
  });
});
