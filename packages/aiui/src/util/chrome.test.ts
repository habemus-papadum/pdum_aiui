import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chromeMcpAttachServer,
  chromeMcpServer,
  findIntentClientExtension,
  probeIntentClientBundle,
  resolveChromeSettings,
  resolveIntentClientExtension,
  sessionBrowserEnabled,
} from "./chrome";
import { writeProfileMarker } from "./profile";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("sessionBrowserEnabled (flag-only since the browser-profiles redesign)", () => {
  const off = { sessionBrowser: false, noSessionBrowser: false };

  it("is on by default outside CI", () => {
    expect(sessionBrowserEnabled(off, {})).toBe(true);
  });

  it("is off under CI", () => {
    expect(sessionBrowserEnabled(off, { CI: "true" })).toBe(false);
    expect(sessionBrowserEnabled(off, { CI: "1" })).toBe(false);
  });

  it("treats an explicitly falsy CI var as not-CI", () => {
    expect(sessionBrowserEnabled(off, { CI: "" })).toBe(true);
    expect(sessionBrowserEnabled(off, { CI: "0" })).toBe(true);
    expect(sessionBrowserEnabled(off, { CI: "false" })).toBe(true);
  });

  it("is off with --aiui-no-session-browser regardless of environment", () => {
    expect(sessionBrowserEnabled({ sessionBrowser: false, noSessionBrowser: true }, {})).toBe(
      false,
    );
  });

  it("is forced on with --aiui-session-browser even under CI", () => {
    expect(
      sessionBrowserEnabled({ sessionBrowser: true, noSessionBrowser: false }, { CI: "true" }),
    ).toBe(true);
  });
});

describe("resolveChromeSettings (the profile picks the browser)", () => {
  function freshCache(): string {
    const cache = mkdtempSync(join(tmpdir(), "aiui-cache-"));
    vi.stubEnv("AIUI_CACHE", cache);
    return cache;
  }

  it("defaults to the user-level default profile", () => {
    const cache = freshCache();
    const settings = resolveChromeSettings({}, {});
    expect(settings.userDataDir).toBe(join(cache, "userdata", "default"));
    expect(settings.browser).toBeUndefined(); // no marker yet
    expect(settings.headless).toBe(false);
  });

  it("reads the browser from the profile marker when present", () => {
    const cache = freshCache();
    writeProfileMarker(join(cache, "userdata", "work"), { managed: "chrome-for-testing" });
    const settings = resolveChromeSettings({ chromeProfile: "work" }, { headless: true });
    expect(settings.browser).toEqual({ managed: "chrome-for-testing" });
    expect(settings.headless).toBe(true);
  });

  it("uses an explicit data dir verbatim, and reads ITS marker", () => {
    freshCache();
    const dir = mkdtempSync(join(tmpdir(), "aiui-datadir-"));
    writeProfileMarker(dir, { channel: "beta" });
    const settings = resolveChromeSettings({ chromeDataDir: dir }, {});
    expect(settings.userDataDir).toBe(dir);
    expect(settings.browser).toEqual({ channel: "beta" });
  });

  it("resolves a relative data dir against base", () => {
    freshCache();
    expect(resolveChromeSettings({ chromeDataDir: "rel/dir" }, {}, "/proj").userDataDir).toBe(
      resolve("/proj", "rel/dir"),
    );
  });

  it("rejects invalid profile names", () => {
    freshCache();
    expect(() => resolveChromeSettings({ chromeProfile: "a/b" }, {})).toThrow(/invalid/);
    expect(() => resolveChromeSettings({ chromeProfile: "UPPER" }, {})).toThrow(/invalid/);
  });
});

describe("chromeMcpServer", () => {
  const launch = { userDataDir: "/data/dir" };

  it("builds the documented npx invocation with the pinned data dir", () => {
    expect(chromeMcpServer(launch)).toEqual({
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
    const { args } = chromeMcpServer({
      ...launch,
      executablePath: "/cft/chrome",
      headless: true,
    });
    expect(args).toContain("--executablePath");
    expect(args).toContain("/cft/chrome");
    expect(args).toContain("--headless");

    const channel = chromeMcpServer({ ...launch, channel: "canary" }).args;
    expect(channel).toContain("--channel");
    expect(channel).toContain("canary");
  });

  it("asks Chrome to load the extensions when dirs are given", () => {
    const { args } = chromeMcpServer(launch, ["/ext/dir"]);
    expect(args).toContain("--chromeArg=--load-extension=/ext/dir");
    expect(args).toContain("--ignoreDefaultChromeArg=--disable-extensions");
  });

  it("comma-joins multiple extension dirs into one --load-extension", () => {
    const { args } = chromeMcpServer(launch, ["/ext/devtools", "/ext/intent"]);
    expect(args).toContain("--chromeArg=--load-extension=/ext/devtools,/ext/intent");
  });

  it("passes no --load-extension when there are no dirs", () => {
    for (const dirs of [[], undefined]) {
      const { args } = chromeMcpServer(launch, dirs);
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

  it("unbuilt until the MV3 bundle exists; ready only once the bundle passes the probe", () => {
    const root = mkdtempSync(join(tmpdir(), "aiui-intent-client-"));
    const paths = { root, outDir: join(root, "dist-ext") };
    expect(resolveIntentClientExtension(paths)).toEqual({ state: "unbuilt", root });

    mkdirSync(paths.outDir, { recursive: true });
    expect(resolveIntentClientExtension(paths)).toEqual({ state: "unbuilt", root }); // dir alone ≠ loadable

    // manifest.json alone is a half-built bundle now, not a loadable one.
    writeFileSync(join(paths.outDir, "manifest.json"), "{}\n");
    expect(resolveIntentClientExtension(paths)).toMatchObject({
      state: "corrupt",
      root,
      dir: paths.outDir,
    });

    mkdirSync(join(paths.outDir, "assets"), { recursive: true });
    writeFileSync(join(paths.outDir, "assets", "index-Abc123.js"), "export {};\n");
    writeFileSync(
      join(paths.outDir, "index.html"),
      '<!doctype html><html><body><div id="root"></div>' +
        '<script type="module" crossorigin src="./assets/index-Abc123.js"></script></body></html>\n',
    );
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

describe("probeIntentClientBundle — integrity beyond existence", () => {
  function bundleDir(): string {
    const outDir = mkdtempSync(join(tmpdir(), "aiui-dist-ext-"));
    mkdirSync(join(outDir, "assets"), { recursive: true });
    return outDir;
  }

  it("flags a missing index.html", () => {
    expect(probeIntentClientBundle(bundleDir())).toMatch(/index\.html is missing/);
  });

  it("flags the empty-chunk build: polyfill tag present, entry tag gone", () => {
    const outDir = bundleDir();
    // The measured 2026-07-21 artifact: a complete-looking index.html whose
    // only script is the modulepreload polyfill — the panel entry chunk was
    // emitted empty and Vite dropped its tag.
    writeFileSync(
      join(outDir, "index.html"),
      '<!doctype html><html><head><script type="module" crossorigin ' +
        'src="./assets/modulepreload-polyfill-B5Qt9EMX.js"></script></head>' +
        '<body><div id="root"></div></body></html>\n',
    );
    writeFileSync(join(outDir, "assets", "modulepreload-polyfill-B5Qt9EMX.js"), "//\n");
    expect(probeIntentClientBundle(outDir)).toMatch(/no panel entry script tag/);
  });

  it("flags an entry tag whose chunk file is missing", () => {
    const outDir = bundleDir();
    writeFileSync(
      join(outDir, "index.html"),
      '<script type="module" crossorigin src="./assets/index-Gone1234.js"></script>\n',
    );
    expect(probeIntentClientBundle(outDir)).toMatch(/index-Gone1234\.js, which does not exist/);
  });

  it("passes a bundle whose entry tag and chunk agree", () => {
    const outDir = bundleDir();
    writeFileSync(join(outDir, "assets", "index-Ok999.js"), "export {};\n");
    writeFileSync(
      join(outDir, "index.html"),
      '<script type="module" crossorigin src="./assets/index-Ok999.js"></script>\n',
    );
    expect(probeIntentClientBundle(outDir)).toBeUndefined();
  });
});
