import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fieldStates,
  readLevels,
  runConfigGet,
  runConfigSet,
  runConfigSetDsp,
  runConfigShow,
  runConfigUnset,
} from "./config";

let dir: string;
let project: string;
let prevCache: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aiui-config-cmd-"));
  project = join(dir, "project");
  mkdirSync(project);
  // Sandbox the user level so tests never touch a real ~/.cache/aiui.
  prevCache = process.env.AIUI_CACHE;
  process.env.AIUI_CACHE = join(dir, "user-cache");
});

afterEach(() => {
  if (prevCache === undefined) delete process.env.AIUI_CACHE;
  else process.env.AIUI_CACHE = prevCache;
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = 0;
  vi.restoreAllMocks();
});

function writeLevel(level: "user" | "project", value: unknown): void {
  const file =
    level === "user"
      ? join(dir, "user-cache", "config.json")
      : join(project, ".aiui-cache", "config.json");
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

describe("fieldStates", () => {
  it("resolves per-level values, the effective value, and provenance", () => {
    writeLevel("user", { chrome: { profile: "user-p", headless: true } });
    writeLevel("project", { chrome: { profile: "proj-p" } });
    const states = fieldStates(readLevels(project));
    const byPath = new Map(states.map((s) => [s.path, s]));

    const profile = byPath.get("chrome.profile");
    expect(profile).toMatchObject({
      userValue: "user-p",
      projectValue: "proj-p",
      effective: "proj-p",
      source: "project",
    });
    expect(byPath.get("chrome.headless")).toMatchObject({ effective: true, source: "user" });
    // Unset with a built-in default vs. unset without one.
    expect(byPath.get("chrome.enabled")).toMatchObject({ effective: undefined, source: "default" });
    expect(byPath.get("chrome.browserUrl")).toMatchObject({
      effective: undefined,
      source: "unset",
    });
  });
});

describe("runConfigShow --json", () => {
  it("emits file paths, both levels, and the effective merge", () => {
    writeLevel("user", { chrome: { mode: "launch" } });
    writeLevel("project", { chrome: { debugPort: 9222 } });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    runConfigShow({ json: true }, project);
    const payload = JSON.parse(log.mock.calls.map((c) => c.join("")).join("\n"));
    expect(payload.files.user.exists).toBe(true);
    expect(payload.files.project.path).toBe(join(project, ".aiui-cache", "config.json"));
    expect(payload.user.chrome.mode).toBe("launch");
    expect(payload.project.chrome.debugPort).toBe(9222);
    expect(payload.effective.chrome).toEqual({ mode: "launch", debugPort: 9222 });
  });
});

describe("runConfigGet", () => {
  it("prints the set value raw on stdout", () => {
    writeLevel("project", { chrome: { mode: "launch" } });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    runConfigGet("chrome.mode", project);
    expect(log).toHaveBeenCalledWith("launch");
  });

  it("falls back to the built-in default when unset", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    runConfigGet("chrome.manage", project);
    expect(log).toHaveBeenCalledWith("prompt");
  });

  it("prints nothing on stdout for unset keys without a default", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    runConfigGet("chrome.browserUrl", project);
    expect(log).not.toHaveBeenCalled();
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("rejects unknown keys with the known-key list", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    runConfigGet("chrome.bogus", project);
    expect(process.exitCode).toBe(1);
    expect(error.mock.calls.flat().join("\n")).toMatch(/chrome\.mode/);
  });
});

describe("runConfigSet", () => {
  it("writes the user level by default, the project level with --project", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    runConfigSet("chrome.mode", "launch", {}, project);
    runConfigSet("chrome.debugPort", "9222", { project: true }, project);
    const paths = readLevels(project).paths;
    expect(JSON.parse(readFileSync(paths.user, "utf8"))).toEqual({ chrome: { mode: "launch" } });
    expect(JSON.parse(readFileSync(paths.project, "utf8"))).toEqual({
      chrome: { debugPort: 9222 },
    });
  });

  it("rejects values the schema rejects, without writing", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const [key, value] of [
      ["chrome.channel", "nightly"],
      ["chrome.debugPort", "70000"],
      ["claude.enterNudge", "maybe"],
    ] as const) {
      process.exitCode = 0;
      runConfigSet(key, value, {}, project);
      expect(process.exitCode).toBe(1);
    }
    expect(readConfig("user")).toBeUndefined();
  });
});

describe("runConfigUnset", () => {
  it("removes the key and drops an emptied section", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    writeLevel("user", {
      claude: { args: ["--dangerously-skip-permissions"] },
      chrome: { mode: "launch" },
    });
    runConfigUnset("claude.args", {}, project);
    expect(readConfig("user")).toEqual({ chrome: { mode: "launch" } });
    // A second unset is a no-op note, not an error.
    runConfigUnset("claude.args", {}, project);
    expect(process.exitCode ?? 0).toBe(0);
  });
});

describe("runConfigSetDsp", () => {
  it("adds --dangerously-skip-permissions to claude.args, idempotently", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    runConfigSetDsp({}, project);
    expect(readConfig("user")).toEqual({ claude: { args: ["--dangerously-skip-permissions"] } });
    // Running again does not duplicate the flag.
    runConfigSetDsp({}, project);
    expect(readConfig("user")).toEqual({ claude: { args: ["--dangerously-skip-permissions"] } });
  });

  it("appends to existing args without disturbing them", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    writeLevel("user", { claude: { args: ["--verbose"] } });
    runConfigSetDsp({}, project);
    expect(readConfig("user")).toEqual({
      claude: { args: ["--verbose", "--dangerously-skip-permissions"] },
    });
  });
});

function readConfig(level: "user" | "project"): unknown {
  const file =
    level === "user"
      ? join(dir, "user-cache", "config.json")
      : join(project, ".aiui-cache", "config.json");
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}
