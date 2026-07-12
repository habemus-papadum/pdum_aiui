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
  devtoolsExtensionDir,
  findIntentExtension,
  intentExtensionDevPort,
  readDevStamp,
  resolveChromeSettings,
  resolveIntentExtension,
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
      buildExtension: true,
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
      { profile: "research", channel: "beta", headless: true, buildExtension: false },
      base,
    );
    expect(settings.userDataDir).toBe(join(base, ".aiui-cache", "chrome", "research"));
    expect(settings.channel).toBe("beta");
    expect(settings.headless).toBe(true);
    expect(settings.buildExtension).toBe(false);
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
    buildExtension: true,
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

describe("devtoolsExtensionDir", () => {
  it("resolves to an extension dir in a dev checkout, or undefined", () => {
    // The concrete result depends on whether aiui-devtools-extension has been built in
    // this checkout (extension/js is gitignored tsc output) — assert the
    // invariant rather than the environment.
    const dir = devtoolsExtensionDir();
    if (dir !== undefined) {
      expect(dir.endsWith(join("aiui-devtools-extension", "extension"))).toBe(true);
    }
  });
});

describe("findIntentExtension", () => {
  it("never reports an unloadable dir", async () => {
    // Environment-dependent like devtoolsExtensionDir above: the state varies
    // with which artifacts this checkout has produced — but "ready" must always
    // mean a loadable unpacked extension, in one of the two known directories.
    const intent = await findIntentExtension();
    if (intent.state === "ready") {
      expect(
        intent.dir.endsWith(join("aiui-extension", "dist")) ||
          intent.dir.endsWith(join("aiui-extension", "dist-dev")),
      ).toBe(true);
      expect(existsSync(join(intent.dir, "manifest.json"))).toBe(true);
    }
  });
});

describe("resolveIntentExtension", () => {
  const up = async () => true;
  const down = async () => false;

  /** A package root with whichever artifacts the test asks for. */
  function checkout(artifacts: { dev?: "dev"; out?: "dev" | "prod" }) {
    const root = mkdtempSync(join(tmpdir(), "aiui-intent-"));
    const paths = { root, devDir: join(root, "dist-dev"), outDir: join(root, "dist") };
    const write = (dir: string, shape: "dev" | "prod") => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "manifest.json"), "{}\n");
      writeFileSync(
        join(dir, "service-worker-loader.js"),
        shape === "dev"
          ? "import 'http://localhost:5317/src/sw.ts';\n"
          : "import './assets/sw.js';\n",
      );
      if (shape === "dev") {
        writeFileSync(
          join(dir, "aiui-dev.json"),
          JSON.stringify({
            runId: "r1",
            origin: "http://localhost:5317",
            port: 5317,
            startedAt: "now",
          }),
        );
      }
    };
    if (artifacts.dev) {
      write(paths.devDir, artifacts.dev);
    }
    if (artifacts.out) {
      write(paths.outDir, artifacts.out);
    }
    return paths;
  }

  it("reports unbuilt when neither artifact exists", async () => {
    const paths = checkout({});
    expect(await resolveIntentExtension(paths, up)).toEqual({ state: "unbuilt", root: paths.root });
  });

  it("prefers the dev artifact when its dev server is answering", async () => {
    const paths = checkout({ dev: "dev", out: "prod" });
    const intent = await resolveIntentExtension(paths, up);
    expect(intent).toMatchObject({
      state: "ready",
      dir: paths.devDir,
      mode: "dev",
      devPort: 5317,
      devServer: true,
    });
  });

  it("falls back to the production build when no dev server answers", async () => {
    const paths = checkout({ dev: "dev", out: "prod" });
    expect(await resolveIntentExtension(paths, down)).toMatchObject({
      state: "ready",
      dir: paths.outDir,
      mode: "prod",
    });
  });

  it("loads a serverless dev artifact anyway when there is no production build", async () => {
    const paths = checkout({ dev: "dev" });
    expect(await resolveIntentExtension(paths, down)).toMatchObject({
      state: "ready",
      dir: paths.devDir,
      mode: "dev",
      devServer: false,
    });
  });

  it("never mistakes a pre-split dev-shaped dist/ for a production build", async () => {
    const paths = checkout({ out: "dev" });
    const intent = await resolveIntentExtension(paths, down);
    expect(intent).toMatchObject({
      state: "ready",
      dir: paths.outDir,
      mode: "dev",
      legacyDevDist: paths.outDir,
    });
  });

  it("reads the dev stamp the kit writes when the artifact is complete", () => {
    const paths = checkout({ dev: "dev" });
    expect(readDevStamp(paths.devDir)).toMatchObject({ runId: "r1", port: 5317 });
    expect(readDevStamp(paths.outDir)).toBeUndefined();
  });
});

describe("intentExtensionDevPort", () => {
  it("reads the dev-server port out of CRXJS dev loader stubs", () => {
    const dir = mkdtempSync(join(tmpdir(), "aiui-intent-ext-"));
    writeFileSync(
      join(dir, "service-worker-loader.js"),
      "import 'http://localhost:5317/@vite/env';\nimport 'http://localhost:5317/src/sw.ts';\n",
    );
    expect(intentExtensionDevPort(dir)).toBe(5317);
  });

  it("treats relative (production) imports as not dev-shaped", () => {
    const dir = mkdtempSync(join(tmpdir(), "aiui-intent-ext-"));
    writeFileSync(join(dir, "service-worker-loader.js"), "import './assets/sw.js';\n");
    expect(intentExtensionDevPort(dir)).toBeUndefined();
  });

  it("is undefined when the loader stub is missing entirely", () => {
    const dir = mkdtempSync(join(tmpdir(), "aiui-intent-ext-"));
    expect(intentExtensionDevPort(dir)).toBeUndefined();
  });
});
