import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decideBrowserAction,
  discoverSessionBrowser,
  discoverSessionBrowserUnder,
  sessionBrowserBinary,
} from "./browser";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aiui-browser-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("discoverSessionBrowser", () => {
  it("finds nothing for a profile without a DevToolsActivePort file", async () => {
    expect(await discoverSessionBrowser(dir)).toBeUndefined();
    expect(await discoverSessionBrowser(join(dir, "missing"))).toBeUndefined();
  });

  it("rejects a garbage port file", async () => {
    writeFileSync(join(dir, "DevToolsActivePort"), "not-a-port\n/devtools/browser/x");
    expect(await discoverSessionBrowser(dir)).toBeUndefined();
  });

  it("rejects a stale port file whose endpoint is dead", async () => {
    // A port from a long-gone browser: nothing listens, the liveness probe
    // fails, and discovery treats the profile as browserless.
    writeFileSync(join(dir, "DevToolsActivePort"), "54321\n/devtools/browser/dead");
    expect(await discoverSessionBrowser(dir)).toBeUndefined();
  });
});

describe("discoverSessionBrowserUnder", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("nothing under a project that never launched", async () => {
    expect(await discoverSessionBrowserUnder(dir)).toBeUndefined();
  });

  it("a live VARIANT profile wins over a stale flat-layout leftover (found live 2026-07-19)", async () => {
    // The exact confusion this exists to fix: a dead port file in the legacy
    // flat layout, a living browser under the per-variant layout.
    const flat = join(dir, ".aiui-cache", "chrome", "default");
    const variant = join(dir, ".aiui-cache", "chrome", "chromium", "default");
    mkdirSync(flat, { recursive: true });
    mkdirSync(variant, { recursive: true });
    writeFileSync(join(flat, "DevToolsActivePort"), "50018\n/devtools/browser/dead");
    writeFileSync(join(variant, "DevToolsActivePort"), "62952\n/devtools/browser/live");
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (String(input).includes(":62952/")) {
        return { ok: true } as Response;
      }
      throw new Error("ECONNREFUSED");
    });
    expect(await discoverSessionBrowserUnder(dir)).toEqual({
      browserUrl: "http://127.0.0.1:62952",
      port: 62952,
    });
  });

  it("every profile stale -> undefined (never a dead endpoint)", async () => {
    const flat = join(dir, ".aiui-cache", "chrome", "default");
    mkdirSync(flat, { recursive: true });
    writeFileSync(join(flat, "DevToolsActivePort"), "50018\n/devtools/browser/dead");
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(await discoverSessionBrowserUnder(dir)).toBeUndefined();
  });
});

describe("sessionBrowserBinary", () => {
  it("prefers an explicit executablePath verbatim", () => {
    expect(sessionBrowserBinary({ executablePath: "/x/chrome" })).toBe("/x/chrome");
    mkdirSync(join(dir, "bin"), { recursive: true });
    expect(sessionBrowserBinary({ executablePath: join(dir, "bin") })).toBe(join(dir, "bin"));
  });
});

describe("decideBrowserAction", () => {
  const noFlags = { browser: false, noBrowser: false };
  const gui = {}; // empty env on darwin: a GUI is presumed
  const ci = { CI: "true" };

  it("opens by default on a machine with a display", () => {
    expect(decideBrowserAction(noFlags, {}, gui, "darwin")).toEqual({ kind: "open" });
    expect(decideBrowserAction(noFlags, {}, { DISPLAY: ":0" }, "linux")).toEqual({ kind: "open" });
  });

  it("skips silently with the suppress flag, whatever else is true", () => {
    expect(decideBrowserAction({ browser: false, noBrowser: true }, {}, gui, "darwin")).toEqual({
      kind: "skip",
    });
    expect(
      decideBrowserAction(
        { browser: false, noBrowser: true },
        { browserUrl: "http://x:1" },
        ci,
        "linux",
      ),
    ).toEqual({ kind: "skip" });
  });

  it("forces open with the force flag, even under CI/headless", () => {
    expect(decideBrowserAction({ browser: true, noBrowser: false }, {}, ci, "linux")).toEqual({
      kind: "open",
    });
  });

  it("opens against a configured browserUrl even when this machine is headless", () => {
    // The whole point of chrome.browserUrl is that the browser lives elsewhere
    // (typically tunneled from the user's local machine).
    expect(
      decideBrowserAction(
        noFlags,
        { browserUrl: "http://127.0.0.1:9222" },
        { SSH_TTY: "/dev/pts/0" },
        "linux",
      ),
    ).toEqual({ kind: "open" });
  });

  it("hints instead of opening in CI and headless environments, carrying the reason", () => {
    expect(decideBrowserAction(noFlags, {}, ci, "darwin")).toEqual({
      kind: "hint",
      reason: expect.stringMatching(/CI/),
    });
    expect(decideBrowserAction(noFlags, {}, { SSH_CONNECTION: "a b c d" }, "darwin")).toEqual({
      kind: "hint",
      reason: expect.stringMatching(/SSH/),
    });
    expect(decideBrowserAction(noFlags, {}, {}, "linux")).toEqual({
      kind: "hint",
      reason: expect.stringMatching(/DISPLAY/),
    });
  });
});
