import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAiuiConfig, mergeAiuiConfig, readConfigFile, updateUserConfig } from "./config";

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
      claude: { skipPermissions: false },
      chrome: { enabled: true, profile: "p", headless: true, channel: "beta" },
    });
    expect(readConfigFile(path)).toEqual({
      claude: { skipPermissions: false },
      chrome: {
        enabled: true,
        profile: "p",
        dataDir: undefined,
        executablePath: undefined,
        channel: "beta",
        headless: true,
        buildExtension: undefined,
      },
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

  it("rejects wrong value types and bad channels", () => {
    expect(() => readConfigFile(write("a.json", { claude: { skipPermissions: "yes" } }))).toThrow(
      /expected a boolean for claude.skipPermissions/,
    );
    expect(() => readConfigFile(write("b.json", { chrome: { channel: "nightly" } }))).toThrow(
      /invalid chrome.channel "nightly"/,
    );
  });

  it("accepts and validates chrome.forTesting", () => {
    const path = write("ft.json", { chrome: { forTesting: "auto" } });
    expect(readConfigFile(path)?.chrome?.forTesting).toBe("auto");
    expect(() => readConfigFile(write("bad.json", { chrome: { forTesting: "maybe" } }))).toThrow(
      /invalid chrome.forTesting "maybe"/,
    );
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

  it("accepts and validates chrome.mode", () => {
    const path = write("mode.json", { chrome: { mode: "launch" } });
    expect(readConfigFile(path)?.chrome?.mode).toBe("launch");
    expect(() => readConfigFile(write("bad.json", { chrome: { mode: "detach" } }))).toThrow(
      /invalid chrome.mode "detach"/,
    );
  });

  it("accepts and validates chrome.browserUrl", () => {
    const path = write("url.json", { chrome: { browserUrl: "http://127.0.0.1:9222" } });
    expect(readConfigFile(path)?.chrome?.browserUrl).toBe("http://127.0.0.1:9222");
    expect(() =>
      readConfigFile(write("bad.json", { chrome: { browserUrl: "127.0.0.1:9222" } })),
    ).toThrow(/invalid chrome.browserUrl/);
  });

  it("accepts and validates chrome.debugPort", () => {
    const path = write("port.json", { chrome: { debugPort: 9222 } });
    expect(readConfigFile(path)?.chrome?.debugPort).toBe(9222);
    expect(() => readConfigFile(write("bad1.json", { chrome: { debugPort: "9222" } }))).toThrow(
      /expected a number for chrome.debugPort/,
    );
    expect(() => readConfigFile(write("bad2.json", { chrome: { debugPort: 70000 } }))).toThrow(
      /invalid chrome.debugPort/,
    );
  });
});

describe("updateUserConfig", () => {
  it("creates, mutates, and preserves the user-level file", () => {
    const file = updateUserConfig((c) => {
      c.chrome = { ...c.chrome, forTesting: "off" };
    });
    expect(file).toBe(join(dir, "user-cache", "config.json"));
    updateUserConfig((c) => {
      c.claude = { skipPermissions: false };
    });
    const config = readConfigFile(file);
    expect(config?.chrome?.forTesting).toBe("off");
    expect(config?.claude?.skipPermissions).toBe(false);
  });
});

describe("mergeAiuiConfig", () => {
  it("merges section-by-section with the override winning per key", () => {
    const merged = mergeAiuiConfig(
      { claude: { skipPermissions: false }, chrome: { profile: "user", headless: true } },
      { chrome: { profile: "project" } },
    );
    expect(merged.claude?.skipPermissions).toBe(false);
    expect(merged.chrome?.profile).toBe("project");
    expect(merged.chrome?.headless).toBe(true);
  });
});

describe("loadAiuiConfig", () => {
  it("merges the user cache config with the project config, project winning", () => {
    write("user-cache/config.json", { chrome: { profile: "user", headless: true } });
    const project = join(dir, "project");
    mkdirSync(join(project, ".aiui-cache"), { recursive: true });
    writeFileSync(
      join(project, ".aiui-cache", "config.json"),
      JSON.stringify({ chrome: { profile: "project" } }),
    );

    const config = loadAiuiConfig(project);
    expect(config.chrome?.profile).toBe("project");
    expect(config.chrome?.headless).toBe(true);
  });

  it("is empty when neither file exists", () => {
    expect(loadAiuiConfig(join(dir, "empty-project"))).toEqual({
      claude: {},
      channel: {},
      sidecars: {},
      chrome: {},
    });
  });
});
