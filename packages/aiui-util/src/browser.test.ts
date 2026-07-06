import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decideBrowserAction, discoverSessionBrowser, sessionBrowserBinary } from "./browser";

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

  it("forces open with the force flag, even under CI/headless or enabled: false", () => {
    expect(decideBrowserAction({ browser: true, noBrowser: false }, {}, ci, "linux")).toEqual({
      kind: "open",
    });
    expect(
      decideBrowserAction({ browser: true, noBrowser: false }, { enabled: false }, gui, "darwin"),
    ).toEqual({ kind: "open" });
  });

  it("skips when config disables the browser wholesale", () => {
    expect(decideBrowserAction(noFlags, { enabled: false }, gui, "darwin")).toEqual({
      kind: "skip",
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
