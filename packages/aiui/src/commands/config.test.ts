import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fieldStates,
  readLoadedConfig,
  runConfigGet,
  runConfigSet,
  runConfigSetDsp,
  runConfigShow,
  runConfigUnset,
} from "./config";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aiui-config-cmd-"));
  // Sandbox the user cache so tests never touch a real ~/.cache/aiui.
  vi.stubEnv("AIUI_CACHE", join(dir, "user-cache"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = 0;
  vi.restoreAllMocks();
});

function writeConfig(value: unknown): void {
  const file = join(dir, "user-cache", "config.json");
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

function readWritten(): unknown {
  return JSON.parse(readFileSync(join(dir, "user-cache", "config.json"), "utf8"));
}

describe("fieldStates", () => {
  it("resolves set values; unset fields carry no value", () => {
    writeConfig({ chrome: { headless: true }, channel: { bind: "host" } });
    const states = fieldStates(readLoadedConfig());
    const byPath = new Map(states.map((s) => [s.path, s]));
    expect(byPath.get("chrome.headless")?.value).toBe(true);
    expect(byPath.get("channel.bind")?.value).toBe("host");
    expect(byPath.get("chrome.manage")?.value).toBeUndefined(); // default applies
    expect(byPath.get("claude.args")?.value).toBeUndefined(); // no default either
  });

  it("covers exactly the schema (the retired chrome keys are gone)", () => {
    const paths = fieldStates(readLoadedConfig()).map((s) => s.path);
    expect(paths).toEqual([
      "claude.args",
      "claude.enterNudge",
      "channel.bind",
      "chrome.manage",
      "chrome.headless",
      "keys.openai",
      "keys.gemini",
      "keys.elevenlabs",
    ]);
  });
});

describe("runConfigSet / runConfigGet / runConfigUnset", () => {
  it("round-trips a validated write", () => {
    runConfigSet("channel.bind", "host");
    expect(readWritten()).toEqual({ channel: { bind: "host" } });

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => {
      logs.push(line);
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    runConfigGet("channel.bind");
    expect(logs).toEqual(["host"]);
  });

  it("rejects invalid values and retired keys with exit code 1", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    runConfigSet("channel.bind", "everywhere");
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    runConfigSet("chrome.profile", "x"); // retired key — no longer settable
    expect(process.exitCode).toBe(1);
  });

  it("unset removes the key and prunes an empty section", () => {
    runConfigSet("chrome.headless", "true");
    runConfigUnset("chrome.headless");
    expect(readWritten()).toEqual({});
  });
});

describe("runConfigSetDsp", () => {
  it("appends the flag once, idempotently", () => {
    runConfigSetDsp();
    runConfigSetDsp();
    expect(readWritten()).toEqual({
      claude: { args: ["--dangerously-skip-permissions"] },
    });
  });
});

describe("runConfigShow", () => {
  it("emits the file and parsed config as JSON", () => {
    writeConfig({ chrome: { manage: "off" } });
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => {
      logs.push(line);
    });
    runConfigShow({ json: true });
    const parsed = JSON.parse(logs.join("\n")) as {
      file: { path: string; exists: boolean };
      config: unknown;
    };
    expect(parsed.file.exists).toBe(true);
    expect(parsed.config).toEqual({ chrome: { manage: "off" } });
  });

  it("tolerates retired chrome keys in an old config (dropped, not fatal)", () => {
    writeConfig({ chrome: { managed: "chromium", profile: "p", manage: "auto" } });
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => {
      logs.push(line);
    });
    runConfigShow({ json: true });
    const parsed = JSON.parse(logs.join("\n")) as { config: unknown };
    expect(parsed.config).toEqual({ chrome: { manage: "auto" } });
  });
});
