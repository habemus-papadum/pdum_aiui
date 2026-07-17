import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type ChromeSettings,
  chromeDevtoolsEnabled,
  chromeMcpAttachServer,
  chromeMcpServer,
  chromeUserDataDir,
  findIntentClientExtension,
  resolveChromeSettings,
  resolveIntentClientExtension,
} from "./chrome";

describe("chromeDevtoolsEnabled", () => {
  const off = { chrome: false, noChrome: false };

  it("is on by default outside CI", () => {
    expect(chromeDevtoolsEnabled(off, {}, {})).toBe(true);
  });

  it("is off under CI", () => {
    expect(chromeDevtoolsEnabled(off, {}, { CI: "true" })).toBe(false);
    expect(chromeDevtoolsEnabled(off, {}, { CI: "1" })).toBe(false);
  });

  it("treats an explicitly falsy CI var as not-CI", () => {
    expect(chromeDevtoolsEnabled(off, {}, { CI: "" })).toBe(true);
    expect(chromeDevtoolsEnabled(off, {}, { CI: "0" })).toBe(true);
    expect(chromeDevtoolsEnabled(off, {}, { CI: "false" })).toBe(true);
  });

  it("is off with --aiui-no-chrome regardless of environment or config", () => {
    expect(chromeDevtoolsEnabled({ chrome: false, noChrome: true }, {}, {})).toBe(false);
    expect(chromeDevtoolsEnabled({ chrome: false, noChrome: true }, { enabled: true }, {})).toBe(
      false,
    );
  });

  it("is off with chrome.enabled: false in config", () => {
    expect(chromeDevtoolsEnabled(off, { enabled: false }, {})).toBe(false);
  });

  it("is forced on with --aiui-chrome even under CI or enabled: false", () => {
    expect(chromeDevtoolsEnabled({ chrome: true, noChrome: false }, {}, { CI: "true" })).toBe(true);
    expect(chromeDevtoolsEnabled({ chrome: true, noChrome: false }, { enabled: false }, {})).toBe(
      true,
    );
  });

  it("does not let chrome.enabled: true override the CI default-off", () => {
    expect(chromeDevtoolsEnabled(off, { enabled: true }, { CI: "true" })).toBe(false);
  });
});

describe("chromeUserDataDir", () => {
  const base = "/proj";

  it("defaults to .aiui-cache/chrome/default under the base dir", () => {
    expect(chromeUserDataDir({}, base)).toBe(join(base, ".aiui-cache", "chrome", "default"));
  });

  it("maps a named profile to a sibling directory", () => {
    expect(chromeUserDataDir({ profile: "scratch" }, base)).toBe(
      join(base, ".aiui-cache", "chrome", "scratch"),
    );
  });

  it("rejects profile names that aren't plain directory names", () => {
    expect(() => chromeUserDataDir({ profile: "a/b" }, base)).toThrow(/invalid/);
    expect(() => chromeUserDataDir({ profile: "../up" }, base)).toThrow(/invalid/);
    expect(() => chromeUserDataDir({ profile: ".hidden" }, base)).toThrow(/invalid/);
  });

  it("uses an explicit data dir verbatim (absolute) or resolved against base", () => {
    expect(chromeUserDataDir({ dataDir: "/elsewhere/profile" }, base)).toBe("/elsewhere/profile");
    expect(chromeUserDataDir({ dataDir: "rel/profile" }, base)).toBe(resolve(base, "rel/profile"));
  });
});

describe("resolveChromeSettings", () => {
  const base = "/proj";
  const defaultDir = join(base, ".aiui-cache", "chrome", "default");

  it("uses plain defaults when neither flags nor config say anything", () => {
    expect(resolveChromeSettings({}, {}, base)).toEqual({
      userDataDir: defaultDir,
      mode: "attach",
      browserUrl: undefined,
      debugPort: 0,
      executablePath: undefined,
      channel: undefined,
      headless: false,
    });
  });

  it("carries mode and debugPort from config, and browserUrl forces attach", () => {
    expect(resolveChromeSettings({}, { mode: "launch", debugPort: 9222 }, base)).toMatchObject({
      mode: "launch",
      debugPort: 9222,
    });
    expect(
      resolveChromeSettings({}, { mode: "launch", browserUrl: "http://127.0.0.1:9222" }, base),
    ).toMatchObject({ mode: "attach", browserUrl: "http://127.0.0.1:9222" });
  });

  it("takes profile/dataDir and browser choices from config", () => {
    const settings = resolveChromeSettings(
      {},
      { profile: "research", channel: "beta", headless: true },
      base,
    );
    expect(settings.userDataDir).toBe(join(base, ".aiui-cache", "chrome", "research"));
    expect(settings.channel).toBe("beta");
    expect(settings.headless).toBe(true);
  });

  it("lets a profile flag beat both config identities", () => {
    const settings = resolveChromeSettings(
      { chromeProfile: "cli" },
      { profile: "cfg", dataDir: "/cfg/dir" },
      base,
    );
    expect(settings.userDataDir).toBe(join(base, ".aiui-cache", "chrome", "cli"));
  });

  it("lets a data-dir flag beat both config identities", () => {
    const settings = resolveChromeSettings(
      { chromeDataDir: "/cli/dir" },
      { profile: "cfg", dataDir: "/cfg/dir" },
      base,
    );
    expect(settings.userDataDir).toBe("/cli/dir");
  });

  it("prefers dataDir over profile within config alone", () => {
    const settings = resolveChromeSettings({}, { profile: "cfg", dataDir: "/cfg/dir" }, base);
    expect(settings.userDataDir).toBe("/cfg/dir");
  });

  it("resolves a relative executablePath against base", () => {
    const settings = resolveChromeSettings({}, { executablePath: "bin/chrome" }, base);
    expect(settings.executablePath).toBe(resolve(base, "bin/chrome"));
  });

  it("rejects executablePath and channel together", () => {
    expect(() =>
      resolveChromeSettings({}, { executablePath: "/x/chrome", channel: "dev" }, base),
    ).toThrow(/exactly one/);
  });
});

describe("chromeMcpServer", () => {
  const settings = (over: Partial<ChromeSettings> = {}): ChromeSettings => ({
    userDataDir: "/data/dir",
    mode: "launch",
    debugPort: 0,
    headless: false,
    ...over,
  });

  it("builds the documented npx invocation with the pinned data dir", () => {
    expect(chromeMcpServer(settings())).toEqual({
      command: "npx",
      args: [
        "-y",
        "chrome-devtools-mcp@latest",
        "--userDataDir",
        "/data/dir",
        "--ignoreDefaultChromeArg=--disable-extensions",
      ],
    });
  });

  it("passes through the browser choice and headless", () => {
    const { args } = chromeMcpServer(settings({ executablePath: "/cft/chrome", headless: true }));
    expect(args).toContain("--executablePath");
    expect(args).toContain("/cft/chrome");
    expect(args).toContain("--headless");

    const channel = chromeMcpServer(settings({ channel: "canary" })).args;
    expect(channel).toContain("--channel");
    expect(channel).toContain("canary");
  });

  it("asks Chrome to load the extensions when dirs are given", () => {
    const { args } = chromeMcpServer(settings(), ["/ext/dir"]);
    expect(args).toContain("--chromeArg=--load-extension=/ext/dir");
    expect(args).toContain("--ignoreDefaultChromeArg=--disable-extensions");
  });

  it("comma-joins multiple extension dirs into one --load-extension", () => {
    const { args } = chromeMcpServer(settings(), ["/ext/devtools", "/ext/intent"]);
    expect(args).toContain("--chromeArg=--load-extension=/ext/devtools,/ext/intent");
  });

  it("passes no --load-extension when there are no dirs", () => {
    for (const dirs of [[], undefined]) {
      const { args } = chromeMcpServer(settings(), dirs);
      expect(args.some((a) => a.includes("--load-extension"))).toBe(false);
    }
  });
});

describe("chromeMcpAttachServer", () => {
  it("attaches by URL and manages nothing else", () => {
    expect(chromeMcpAttachServer("http://127.0.0.1:9222")).toEqual({
      command: "npx",
      args: ["-y", "chrome-devtools-mcp@latest", "--browser-url", "http://127.0.0.1:9222"],
    });
  });
});

describe("resolveIntentClientExtension — the extension launches auto-load", () => {
  it("absent when the package is not resolvable", () => {
    expect(resolveIntentClientExtension(undefined)).toEqual({ state: "absent" });
  });

  it("unbuilt until the MV3 bundle exists; ready once manifest.json does", () => {
    const root = mkdtempSync(join(tmpdir(), "aiui-intent-client-"));
    const paths = { root, outDir: join(root, "dist-ext") };
    expect(resolveIntentClientExtension(paths)).toEqual({ state: "unbuilt", root });

    mkdirSync(paths.outDir, { recursive: true });
    expect(resolveIntentClientExtension(paths)).toEqual({ state: "unbuilt", root }); // dir alone ≠ loadable

    writeFileSync(join(paths.outDir, "manifest.json"), "{}\n");
    expect(resolveIntentClientExtension(paths)).toEqual({ state: "ready", dir: paths.outDir });
  });

  it("resolves in this checkout, and ready always means a loadable unpacked dir", () => {
    const intent = findIntentClientExtension();
    expect(intent.state).not.toBe("absent"); // the workspace dep is here
    if (intent.state === "ready") {
      expect(intent.dir.endsWith(join("aiui-intent-client", "dist-ext"))).toBe(true);
      expect(existsSync(join(intent.dir, "manifest.json"))).toBe(true);
    }
  });
});
