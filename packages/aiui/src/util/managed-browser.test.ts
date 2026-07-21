import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CHECK_TTL_MS,
  compareBuildIds,
  flavorSpec,
  latestManaged,
  MANAGED_FLAVOR_SPECS,
  managedCacheDir,
  readManagedState,
  syncManagedBrowser,
  writeManagedState,
} from "./managed-browser";

let dir: string;
let prevCache: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aiui-managed-"));
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

describe("managed flavor specs", () => {
  it("chromium tracks the snapshot 'latest', CfT tracks the stable release", () => {
    expect(MANAGED_FLAVOR_SPECS.chromium.latestTag).toBe("latest");
    expect(MANAGED_FLAVOR_SPECS["chrome-for-testing"].latestTag).toBe("stable");
  });

  it("keeps the two flavors in separate cache dirs", () => {
    expect(managedCacheDir("chromium", false)).not.toBe(
      managedCacheDir("chrome-for-testing", false),
    );
    expect(managedCacheDir("chromium", false).endsWith("chromium")).toBe(true);
    expect(flavorSpec("chrome-for-testing").cacheSubdir).toBe("chrome");
  });
});

describe("compareBuildIds", () => {
  it("compares dotted CfT build ids segment-wise numerically", () => {
    expect(compareBuildIds("138.0.7204.94", "138.0.7204.94")).toBe(0);
    expect(compareBuildIds("138.0.7204.94", "138.0.7204.100")).toBe(-1);
    expect(compareBuildIds("139.0.0.0", "138.9.9999.99")).toBe(1);
    expect(compareBuildIds("138.0.7204", "138.0.7204.1")).toBe(-1);
  });

  it("compares single-integer Chromium snapshot revisions", () => {
    expect(compareBuildIds("1358901", "1358901")).toBe(0);
    expect(compareBuildIds("1358900", "1358901")).toBe(-1);
    expect(compareBuildIds("1358902", "1358901")).toBe(1);
  });
});

describe("managed state file", () => {
  it("round-trips and merges patches, isolated per flavor", () => {
    expect(readManagedState("chromium")).toEqual({});
    writeManagedState("chromium", { latestBuildId: "1358901", checkedAt: 111 });
    writeManagedState("chromium", { skippedBuildId: "1358901" });
    expect(readManagedState("chromium")).toEqual({
      latestBuildId: "1358901",
      checkedAt: 111,
      skippedBuildId: "1358901",
    });
    // The other flavor's state lives in its own dir, untouched.
    expect(readManagedState("chrome-for-testing")).toEqual({});
  });
});

describe("latestManaged", () => {
  it("returns the cached value while fresh, without touching the network", async () => {
    const now = 1_000_000_000;
    writeManagedState("chromium", {
      checkedAt: now - CHECK_TTL_MS + 5000,
      latestBuildId: "1358901",
    });
    expect(await latestManaged("chromium", { now })).toBe("1358901");
  });

  it("falls back to the stale cached value when the lookup can't complete", async () => {
    const now = 1_000_000_000;
    writeManagedState("chrome-for-testing", { checkedAt: 1, latestBuildId: "9.9.9.9" });
    // timeoutMs: 1 guarantees the live lookup loses the race in this test.
    expect(await latestManaged("chrome-for-testing", { now, timeoutMs: 1 })).toBe("9.9.9.9");
  });
});

describe("syncManagedBrowser", () => {
  it("never prompts or downloads outside an interactive session", async () => {
    // Nothing installed in the sandbox → falls back to the system browser.
    expect(
      await syncManagedBrowser({ flavor: "chromium", mode: "prompt", interactive: false }),
    ).toBeUndefined();
    expect(
      await syncManagedBrowser({ flavor: "chromium", mode: "auto", interactive: false }),
    ).toBeUndefined();
  });

  it('"off" skips every check but still uses an existing install (none here)', async () => {
    expect(
      await syncManagedBrowser({ flavor: "chromium", mode: "off", interactive: true }),
    ).toBeUndefined();
  });

  // A committed managed flavor with nothing installed now downloads with no
  // second prompt (the profile choice was the consent) — an integration path
  // that hits the network, so it is exercised by manual/e2e runs, not here.
  // The unit tests cover only the short-circuits that must never download.
});
