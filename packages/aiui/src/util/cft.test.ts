import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CHECK_TTL_MS,
  compareBuildIds,
  latestStableCft,
  readCftState,
  syncChromeForTesting,
  writeCftState,
} from "./cft";

let dir: string;
let prevCache: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aiui-cft-"));
  // Sandbox the user cache: state files and installed-browser lookups all
  // resolve under AIUI_CACHE, so tests never touch ~/.cache/aiui.
  prevCache = process.env.AIUI_CACHE;
  process.env.AIUI_CACHE = dir;
});

afterEach(() => {
  if (prevCache === undefined) delete process.env.AIUI_CACHE;
  else process.env.AIUI_CACHE = prevCache;
  rmSync(dir, { recursive: true, force: true });
});

describe("compareBuildIds", () => {
  it("compares segment-wise numerically", () => {
    expect(compareBuildIds("138.0.7204.94", "138.0.7204.94")).toBe(0);
    expect(compareBuildIds("138.0.7204.94", "138.0.7204.100")).toBe(-1);
    expect(compareBuildIds("139.0.0.0", "138.9.9999.99")).toBe(1);
    expect(compareBuildIds("138.0.7204", "138.0.7204.1")).toBe(-1);
  });
});

describe("cft state file", () => {
  it("round-trips and merges patches", () => {
    expect(readCftState()).toEqual({});
    writeCftState({ latestBuildId: "1.2.3.4", checkedAt: 111 });
    writeCftState({ skippedBuildId: "1.2.3.4" });
    expect(readCftState()).toEqual({
      latestBuildId: "1.2.3.4",
      checkedAt: 111,
      skippedBuildId: "1.2.3.4",
    });
  });
});

describe("latestStableCft", () => {
  it("returns the cached value while fresh, without touching the network", async () => {
    const now = 1_000_000_000;
    writeCftState({ checkedAt: now - CHECK_TTL_MS + 5000, latestBuildId: "140.0.1.2" });
    expect(await latestStableCft({ now })).toBe("140.0.1.2");
  });

  it("falls back to the stale cached value when the lookup can't complete", async () => {
    const now = 1_000_000_000;
    writeCftState({ checkedAt: 1, latestBuildId: "9.9.9.9" });
    // timeoutMs: 1 guarantees the live lookup loses the race in this test.
    expect(await latestStableCft({ now, timeoutMs: 1 })).toBe("9.9.9.9");
  });
});

describe("syncChromeForTesting", () => {
  it("never prompts or downloads outside an interactive session", async () => {
    // Nothing installed in the sandbox → falls back to the system browser.
    expect(await syncChromeForTesting({ mode: "prompt", interactive: false })).toBeUndefined();
    expect(await syncChromeForTesting({ mode: "auto", interactive: false })).toBeUndefined();
  });

  it('"off" skips every check but still uses an existing install (none here)', async () => {
    expect(await syncChromeForTesting({ mode: "off", interactive: true })).toBeUndefined();
  });

  it("respects a recent install decline instead of re-asking", async () => {
    const now = 2_000_000_000;
    // A fresh "latest" is cached so the offer path needs no network; the
    // recent decline must short-circuit before any prompt.
    writeCftState({
      checkedAt: now - 1000,
      latestBuildId: "141.0.0.1",
      installDeclinedAt: now - 60_000,
    });
    expect(await syncChromeForTesting({ mode: "prompt", interactive: true, now })).toBeUndefined();
  });
});
