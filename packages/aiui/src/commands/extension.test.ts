import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureHostArtifacts,
  INTENT_CLIENT_EXTENSION_ID,
  installProfileNativeHost,
  NATIVE_HOST_NAME,
  nativeHostManifestDirs,
  resolveClaudeBinary,
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

describe("resolveClaudeBinary", () => {
  it("returns the first PATH dir holding an executable claude", () => {
    const hits = new Set(["/opt/tools/claude"]);
    expect(resolveClaudeBinary("/bin:/opt/tools:/usr/bin", (p) => hits.has(p))).toBe(
      "/opt/tools/claude",
    );
  });
  it("returns undefined when nothing matches (empty segments skipped)", () => {
    expect(resolveClaudeBinary("::/bin", () => false)).toBeUndefined();
  });
});

describe("wrapperScript", () => {
  it("bakes the claude path as env and execs the binary (absolute paths only)", () => {
    const script = wrapperScript("/cache/native-host/aiui-registry-host-0.1.0", "/opt/claude");
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).toContain('AIUI_CLAUDE_BIN="/opt/claude"');
    expect(script).toContain("export AIUI_CLAUDE_BIN");
    expect(script).toContain('exec "/cache/native-host/aiui-registry-host-0.1.0"');
  });

  it("omits the env baking when no claude was found — the host reports claude-missing", () => {
    const script = wrapperScript("/cache/host", undefined);
    expect(script).not.toContain("AIUI_CLAUDE_BIN");
    expect(script).toContain('exec "/cache/host"');
  });

  it("escapes shell metacharacters in paths", () => {
    const script = wrapperScript('/od d/$x/"q"', "/c$d/claude");
    expect(script).toContain('exec "/od d/\\$x/\\"q\\""');
    expect(script).toContain('AIUI_CLAUDE_BIN="/c\\$d/claude"');
  });
});

describe("host install (real platform binary from the registry package)", () => {
  let cache: string;
  let profile: string;
  let fakePathDir: string;

  beforeEach(() => {
    cache = mkdtempSync(join(tmpdir(), "aiui-cache-"));
    profile = mkdtempSync(join(tmpdir(), "aiui-profile-"));
    // A deterministic claude on PATH, so the wrapper's baking is assertable
    // regardless of what the machine has installed.
    fakePathDir = mkdtempSync(join(tmpdir(), "aiui-path-"));
    writeFileSync(join(fakePathDir, "claude"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(fakePathDir, "claude"), 0o755);
    vi.stubEnv("AIUI_CACHE", cache);
    vi.stubEnv("PATH", fakePathDir);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const manifestPath = () => join(profile, "NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`);

  it("copies the version-suffixed binary, bakes claude, and writes the manifest", () => {
    const artifacts = ensureHostArtifacts();
    expect(artifacts).toBeDefined();
    if (!artifacts) {
      return;
    }
    expect(basename(artifacts.binary)).toMatch(/^aiui-registry-host-\d+\.\d+\.\d+$/);
    expect(existsSync(artifacts.binary)).toBe(true);
    expect(statSync(artifacts.binary).mode & 0o111).not.toBe(0);
    expect(artifacts.claude).toBe(join(fakePathDir, "claude"));

    const wrapper = readFileSync(artifacts.wrapper, "utf8");
    expect(wrapper).toContain(`AIUI_CLAUDE_BIN="${join(fakePathDir, "claude")}"`);
    expect(wrapper).toContain(`exec "${artifacts.binary}"`);

    installProfileNativeHost(profile);
    const manifest = JSON.parse(readFileSync(manifestPath(), "utf8")) as {
      name: string;
      path: string;
      type: string;
      allowed_origins: string[];
    };
    expect(manifest.name).toBe(NATIVE_HOST_NAME);
    expect(manifest.path).toBe(artifacts.wrapper);
    expect(manifest.type).toBe("stdio");
    expect(manifest.allowed_origins).toEqual([`chrome-extension://${INTENT_CLIENT_EXTENSION_ID}/`]);
  });

  it("honors an explicit extension id", () => {
    installProfileNativeHost(profile, { extensionId: "a".repeat(32) });
    const manifest = JSON.parse(readFileSync(manifestPath(), "utf8")) as {
      allowed_origins: string[];
    };
    expect(manifest.allowed_origins).toEqual([
      `chrome-extension://${"a".repeat(32)}/`,
      `chrome-extension://${INTENT_CLIENT_EXTENSION_ID}/`,
    ]);
  });

  it("is idempotent — unchanged content is not rewritten (launch-time mtime churn)", () => {
    installProfileNativeHost(profile);
    const before = statSync(manifestPath()).mtimeMs;
    installProfileNativeHost(profile);
    expect(statSync(manifestPath()).mtimeMs).toBe(before);
  });
});
