import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAiuiConfig, readConfigFile, updateUserConfig } from "./config";

let dir: string;
let prevCache: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aiui-config-"));
  // Point the user-level cache into the sandbox so tests never read a real
  // ~/.cache/aiui/config.json.
  prevCache = process.env.AIUI_CACHE;
  process.env.AIUI_CACHE = join(dir, "user-cache");
});

afterEach(() => {
  if (prevCache === undefined) delete process.env.AIUI_CACHE;
  else process.env.AIUI_CACHE = prevCache;
  rmSync(dir, { recursive: true, force: true });
});

function write(file: string, value: unknown): string {
  const path = join(dir, file);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  return path;
}

describe("readConfigFile", () => {
  it("returns undefined for a missing file", () => {
    expect(readConfigFile(join(dir, "nope.json"))).toBeUndefined();
  });

  it("parses a full config", () => {
    const path = write("config.json", {
      claude: { args: ["--dangerously-skip-permissions"] },
      chrome: { manage: "auto", headless: true },
      channel: { bind: "host" },
    });
    expect(readConfigFile(path)).toEqual({
      claude: { args: ["--dangerously-skip-permissions"] },
      chrome: { manage: "auto", headless: true },
      channel: { bind: "host" },
    });
  });

  it("names the file on malformed JSON", () => {
    const path = write("config.json", "{ not json");
    expect(() => readConfigFile(path)).toThrow(/invalid JSON in .*config\.json/);
  });

  it("rejects unknown keys so typos surface loudly", () => {
    expect(() => readConfigFile(write("a.json", { claud: {} }))).toThrow(/unknown key "claud"/);
    expect(() => readConfigFile(write("b.json", { claude: { skippermissions: true } }))).toThrow(
      /unknown key "skippermissions"/,
    );
  });

  it("tolerates a retired section (sidecars) instead of hard-failing on upgrade", () => {
    const config = readConfigFile(
      write("legacy.json", { sidecars: { paint: false }, channel: { bind: "host" } }),
    );
    expect(config).toEqual({ channel: { bind: "host" } });
  });

  it("tolerates the retired chrome browser-identity keys, dropping them", () => {
    // The browser-profiles redesign moved identity into the profile marker; a
    // config still carrying the old keys loads fine and drops them (a real
    // typo still throws).
    const config = readConfigFile(
      write("legacy-chrome.json", {
        chrome: {
          enabled: false,
          mode: "launch",
          browserUrl: "http://127.0.0.1:9222",
          debugPort: 9222,
          profile: "p",
          dataDir: "/x",
          executablePath: "/y",
          channel: "beta",
          managed: "chromium",
          forTesting: "auto",
          buildExtension: true,
          autoCapture: false,
          manage: "off",
        },
      }),
    );
    expect(config).toEqual({ chrome: { manage: "off" } });
    expect(() => readConfigFile(write("typo.json", { chrome: { autocapture: true } }))).toThrow(
      /unknown key "autocapture"/,
    );
  });

  it("rejects wrong value types and bad enum values", () => {
    expect(() => readConfigFile(write("a.json", { chrome: { headless: "yes" } }))).toThrow(
      /expected a boolean for chrome.headless/,
    );
    expect(() => readConfigFile(write("b.json", { chrome: { manage: "maybe" } }))).toThrow(
      /invalid chrome.manage "maybe"/,
    );
  });

  it("validates claude.args as an array of strings", () => {
    expect(readConfigFile(write("ok.json", { claude: { args: ["--foo", "--bar"] } }))).toEqual({
      claude: { args: ["--foo", "--bar"] },
    });
    expect(() => readConfigFile(write("scalar.json", { claude: { args: "--foo" } }))).toThrow(
      /expected an array of strings for claude.args/,
    );
    expect(() => readConfigFile(write("mixed.json", { claude: { args: ["--foo", 3] } }))).toThrow(
      /expected an array of strings for claude.args/,
    );
  });

  it("tolerates the retired claude.skipPermissions, dropping it", () => {
    const config = readConfigFile(
      write("legacy-claude.json", { claude: { skipPermissions: true, enterNudge: false } }),
    );
    expect(config).toEqual({ claude: { enterNudge: false } });
  });

  it("accepts and validates channel.bind", () => {
    const path = write("bind.json", { channel: { bind: "host" } });
    expect(readConfigFile(path)?.channel?.bind).toBe("host");
    expect(() => readConfigFile(write("bad.json", { channel: { bind: "0.0.0.0" } }))).toThrow(
      /invalid channel.bind "0\.0\.0\.0"/,
    );
  });

  it("accepts and validates claude.enterNudge", () => {
    const path = write("nudge.json", { claude: { enterNudge: false } });
    expect(readConfigFile(path)?.claude?.enterNudge).toBe(false);
    expect(() => readConfigFile(write("bad.json", { claude: { enterNudge: "no" } }))).toThrow(
      /expected a boolean for claude.enterNudge/,
    );
  });
});

describe("updateUserConfig", () => {
  it("creates, mutates, and preserves the user-level file", () => {
    const file = updateUserConfig((c) => {
      c.chrome = { ...c.chrome, manage: "off" };
    });
    expect(file).toBe(join(dir, "user-cache", "config.json"));
    updateUserConfig((c) => {
      c.claude = { args: ["--dangerously-skip-permissions"] };
    });
    const config = readConfigFile(file);
    expect(config?.chrome?.manage).toBe("off");
    expect(config?.claude?.args).toEqual(["--dangerously-skip-permissions"]);
  });
});

describe("loadAiuiConfig", () => {
  it("loads the ONE user-level file (the project layer is retired)", () => {
    write("user-cache/config.json", { chrome: { headless: true } });
    expect(loadAiuiConfig()).toEqual({ chrome: { headless: true } });
  });

  it("is empty when the file doesn't exist", () => {
    expect(loadAiuiConfig()).toEqual({});
  });
});
