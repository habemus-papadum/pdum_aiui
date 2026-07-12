import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_EXTENSION_ID,
  installProfileNativeHost,
  NATIVE_HOST_NAME,
  nativeHostManifestDirs,
  wrapperScript,
} from "./extension";

describe("nativeHostManifestDirs", () => {
  it("covers Chrome, Chromium, and Edge on macOS and Linux", () => {
    for (const [platform, expected] of [
      ["darwin", ["Google/Chrome", "Chromium", "Microsoft Edge"]],
      ["linux", ["google-chrome", "chromium", "microsoft-edge"]],
    ] as const) {
      const dirs = nativeHostManifestDirs(platform, "/home/u");
      expect(dirs).toHaveLength(expected.length);
      for (const [i, marker] of expected.entries()) {
        expect(dirs[i]).toContain(marker);
        expect(dirs[i].endsWith("NativeMessagingHosts")).toBe(true);
      }
    }
  });

  it("has NO Chrome for Testing entry — CfT reads the user data dir instead (measured)", () => {
    for (const platform of ["darwin", "linux"] as const) {
      for (const dir of nativeHostManifestDirs(platform, "/home/u")) {
        expect(dir.toLowerCase()).not.toContain("testing");
      }
    }
  });

  it("rejects unsupported platforms", () => {
    expect(() => nativeHostManifestDirs("win32", "C:\\Users\\u")).toThrow(/unsupported/);
  });
});

describe("wrapperScript", () => {
  it("cds to an absolute dir and execs absolute paths (Chrome gives NM hosts cwd /)", () => {
    const script = wrapperScript("/repo/packages/aiui", "/usr/bin/node", [
      "--import",
      "tsx",
      "/repo/packages/aiui/src/cli.ts",
    ]);
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).toContain('cd "/repo/packages/aiui" || exit 1');
    expect(script).toContain(
      'exec "/usr/bin/node" "--import" "tsx" "/repo/packages/aiui/src/cli.ts" native-host',
    );
  });

  it("escapes shell metacharacters in paths", () => {
    const script = wrapperScript('/od d/$x/"q"', "/usr/bin/node", []);
    expect(script).toContain('cd "/od d/\\$x/\\"q\\"" || exit 1');
  });
});

describe("installProfileNativeHost", () => {
  let cache: string;
  let profile: string;
  const savedCache = process.env.AIUI_CACHE;

  beforeEach(() => {
    cache = mkdtempSync(join(tmpdir(), "aiui-cache-"));
    profile = mkdtempSync(join(tmpdir(), "aiui-profile-"));
    process.env.AIUI_CACHE = cache;
  });
  afterEach(() => {
    if (savedCache === undefined) {
      delete process.env.AIUI_CACHE;
    } else {
      process.env.AIUI_CACHE = savedCache;
    }
  });

  const manifestPath = () => join(profile, "NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`);

  it("writes an executable wrapper and a manifest pinned to the extension id", () => {
    installProfileNativeHost(profile);

    const wrapper = join(cache, "native-host", "aiui-native-host.sh");
    expect(existsSync(wrapper)).toBe(true);
    expect(statSync(wrapper).mode & 0o111).not.toBe(0);

    const manifest = JSON.parse(readFileSync(manifestPath(), "utf8")) as {
      name: string;
      path: string;
      type: string;
      allowed_origins: string[];
    };
    expect(manifest.name).toBe(NATIVE_HOST_NAME);
    expect(manifest.path).toBe(wrapper);
    expect(manifest.type).toBe("stdio");
    expect(manifest.allowed_origins).toEqual([`chrome-extension://${DEFAULT_EXTENSION_ID}/`]);
  });

  it("honors an explicit extension id", () => {
    installProfileNativeHost(profile, { extensionId: "a".repeat(32) });
    const manifest = JSON.parse(readFileSync(manifestPath(), "utf8")) as {
      allowed_origins: string[];
    };
    expect(manifest.allowed_origins).toEqual([`chrome-extension://${"a".repeat(32)}/`]);
  });

  it("is idempotent — unchanged content is not rewritten (launch-time mtime churn)", () => {
    installProfileNativeHost(profile);
    const before = statSync(manifestPath()).mtimeMs;
    installProfileNativeHost(profile);
    expect(statSync(manifestPath()).mtimeMs).toBe(before);
  });
});
