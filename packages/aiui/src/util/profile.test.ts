import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureProfileMarker,
  isClaimableProfileDir,
  PROFILE_MARKER,
  parseProfileBrowser,
  profileBrowserLabel,
  profileDir,
  readProfileMarker,
  validateProfileName,
  writeProfileMarker,
} from "./profile";

let dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "aiui-profile-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  dirs = [];
  vi.unstubAllEnvs();
});

describe("validateProfileName / profileDir", () => {
  it("accepts lowercase slugs and maps them under the user cache", () => {
    vi.stubEnv("AIUI_CACHE", "/cache");
    expect(profileDir()).toBe(join("/cache", "userdata", "default"));
    expect(profileDir("work-2")).toBe(join("/cache", "userdata", "work-2"));
  });
  it("rejects separators, uppercase, and leading dashes", () => {
    for (const bad of ["a/b", "UPPER", "-x", ".hidden", ""]) {
      expect(() => validateProfileName(bad)).toThrow(/invalid profile name/);
    }
  });
});

describe("parseProfileBrowser", () => {
  it("accepts exactly the three shapes", () => {
    expect(parseProfileBrowser({ managed: "chromium" })).toEqual({ managed: "chromium" });
    expect(parseProfileBrowser({ channel: "beta" })).toEqual({ channel: "beta" });
    expect(parseProfileBrowser({ executablePath: "/x" })).toEqual({ executablePath: "/x" });
  });
  it("rejects unknown flavors/channels and junk", () => {
    expect(parseProfileBrowser({ managed: "firefox" })).toBeUndefined();
    expect(parseProfileBrowser({ channel: "nightly" })).toBeUndefined();
    expect(parseProfileBrowser({ executablePath: "" })).toBeUndefined();
    expect(parseProfileBrowser("chromium")).toBeUndefined();
  });
});

describe("markers", () => {
  it("write → read round-trips, and the marker is immutable", () => {
    const dir = join(tmp(), "p");
    const marker = writeProfileMarker(dir, { managed: "chromium" });
    expect(readProfileMarker(dir)).toEqual(marker);
    expect(() => writeProfileMarker(dir, { channel: "beta" })).toThrow(/immutable/);
  });

  it("malformed markers read as undefined", () => {
    const dir = tmp();
    writeFileSync(join(dir, PROFILE_MARKER), "torn{");
    expect(readProfileMarker(dir)).toBeUndefined();
  });
});

describe("ensureProfileMarker", () => {
  it("claims a missing or empty dir with the silent Chromium default", async () => {
    const dir = join(tmp(), "new");
    const marker = await ensureProfileMarker(dir, { interactive: false });
    expect(marker.browser).toEqual({ managed: "chromium" });
    expect(readProfileMarker(dir)).toEqual(marker);
  });

  it("returns an existing marker untouched", async () => {
    const dir = join(tmp(), "p");
    const written = writeProfileMarker(dir, { channel: "beta" });
    const marker = await ensureProfileMarker(dir, { interactive: true, ask: async () => "c" });
    expect(marker).toEqual(written);
  });

  it("interviews on an interactive first run", async () => {
    const dir = join(tmp(), "p");
    const marker = await ensureProfileMarker(dir, {
      interactive: true,
      profileName: "default",
      ask: async () => "t",
    });
    expect(marker.browser).toEqual({ managed: "chrome-for-testing" });
  });

  it("refuses a foreign (non-empty, markerless) dir with the adopt hint", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "Default"), "chrome stuff");
    await expect(ensureProfileMarker(dir, { interactive: false })).rejects.toThrow(/adopt/i);
  });
});

describe("isClaimableProfileDir / labels", () => {
  it("missing and empty dirs are claimable; populated ones are not", () => {
    const dir = tmp();
    expect(isClaimableProfileDir(join(dir, "nope"))).toBe(true);
    mkdirSync(join(dir, "empty"));
    expect(isClaimableProfileDir(join(dir, "empty"))).toBe(true);
    writeFileSync(join(dir, "empty", "x"), "1");
    expect(isClaimableProfileDir(join(dir, "empty"))).toBe(false);
  });

  it("labels each browser shape", () => {
    expect(profileBrowserLabel({ managed: "chromium" })).toBe("chromium (managed)");
    expect(profileBrowserLabel({ channel: "beta" })).toBe("chrome beta");
    expect(profileBrowserLabel({ executablePath: "/x/chrome" })).toBe("/x/chrome");
  });

  it("marker files are pretty-printed JSON (inspectable by hand)", () => {
    const dir = join(tmp(), "p");
    writeProfileMarker(dir, { managed: "chromium" });
    const raw = readFileSync(join(dir, PROFILE_MARKER), "utf8");
    expect(raw).toContain('"schema": 1');
    expect(raw.endsWith("\n")).toBe(true);
  });
});
