import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverSessionBrowser, sessionBrowserBinary } from "./browser";

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
