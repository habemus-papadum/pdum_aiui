import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cacheDir } from "./index";

describe("cacheDir", () => {
  beforeEach(() => {
    // Start each test from a clean slate so the host's real env doesn't leak in.
    vi.unstubAllEnvs();
    vi.stubEnv("AIUI_CACHE", "");
    vi.stubEnv("XDG_CACHE_HOME", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses $AIUI_CACHE verbatim when set", () => {
    vi.stubEnv("AIUI_CACHE", "/tmp/custom-aiui-cache");
    expect(cacheDir(undefined, { create: false })).toBe("/tmp/custom-aiui-cache");
  });

  it("honors $XDG_CACHE_HOME (absolute) with an aiui leaf", () => {
    vi.stubEnv("XDG_CACHE_HOME", "/tmp/xdg");
    expect(cacheDir(undefined, { create: false })).toBe("/tmp/xdg/aiui");
  });

  it("ignores a relative $XDG_CACHE_HOME per the spec", () => {
    vi.stubEnv("XDG_CACHE_HOME", "relative/cache");
    expect(cacheDir(undefined, { create: false })).toBe(join(homedir(), ".cache", "aiui"));
  });

  it("falls back to ~/.cache/aiui", () => {
    expect(cacheDir(undefined, { create: false })).toBe(join(homedir(), ".cache", "aiui"));
  });

  it("appends a namespace subdirectory", () => {
    vi.stubEnv("AIUI_CACHE", "/tmp/base");
    expect(cacheDir("claude", { create: false })).toBe("/tmp/base/claude");
  });

  it("creates the directory by default", () => {
    const tmp = mkdtempSync(join(tmpdir(), "aiui-util-"));
    try {
      vi.stubEnv("AIUI_CACHE", tmp);
      const dir = cacheDir("screenshots");
      expect(dir).toBe(join(tmp, "screenshots"));
      expect(existsSync(dir)).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
