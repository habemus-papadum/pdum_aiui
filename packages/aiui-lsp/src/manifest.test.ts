import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeManifest } from "./generate";
import {
  type LspManifest,
  languageIdForPath,
  launcherPath,
  cacheLspDir,
  loadManifest,
  lspDir,
  manifestPath,
  resolveLspDir,
  serverForExtension,
  serverForLanguageId,
  validateManifest,
} from "./manifest";

const sample = (): LspManifest => ({
  version: 1,
  createdAt: "2026-07-06T00:00:00.000Z",
  servers: [
    {
      language: "typescript",
      languageId: "typescript",
      extensions: [".ts", ".tsx"],
      launcher: "typescript/launch",
      name: "typescript-language-server 5.3.0",
      doc: "typescript/SETUP.md",
      initializationOptions: { tsserver: { path: "/x/tsserver.js" } },
      verified: { at: "2026-07-06T00:00:00.000Z", ops: ["initialize"], ok: true },
    },
    // language key deliberately differs from languageId, to exercise the
    // language-key fallback in serverForLanguageId.
    {
      language: "cpp",
      languageId: "cpp-lang",
      extensions: [".hpp", ".cpp"],
      launcher: "cpp/launch",
    },
  ],
});

// --- validateManifest ------------------------------------------------------

describe("validateManifest", () => {
  it("accepts a well-formed manifest", () => {
    expect(validateManifest(sample())).toEqual(sample());
  });

  it("rejects a non-object", () => {
    expect(() => validateManifest(null)).toThrow(/not an object/);
  });

  it("rejects an unsupported version", () => {
    expect(() => validateManifest({ version: 2, servers: [] })).toThrow(/unsupported version/);
  });

  it("rejects a non-array servers field", () => {
    expect(() => validateManifest({ version: 1, servers: "nope" })).toThrow(/servers.*array/);
  });

  it("rejects an entry missing a required string field", () => {
    const bad = { version: 1, servers: [{ languageId: "ts", extensions: [".ts"], launcher: "x" }] };
    expect(() => validateManifest(bad)).toThrow(/language.*non-empty string/);
  });

  it("rejects an entry whose extensions is not a string array", () => {
    const notArray = {
      version: 1,
      servers: [{ language: "ts", languageId: "ts", extensions: "x", launcher: "y" }],
    };
    expect(() => validateManifest(notArray)).toThrow(/extensions.*string\[\]/);

    const badElement = {
      version: 1,
      servers: [{ language: "ts", languageId: "ts", extensions: [".ts", 5], launcher: "y" }],
    };
    expect(() => validateManifest(badElement)).toThrow(/extensions.*string\[\]/);
  });

  it("names the offending entry index in the error", () => {
    const bad = {
      version: 1,
      servers: [sample().servers[0], { language: "x", languageId: "x", extensions: [".x"] }],
    };
    expect(() => validateManifest(bad)).toThrow(/servers\[1\].launcher/);
  });
});

// --- lookups ---------------------------------------------------------------

describe("serverForExtension", () => {
  it("matches with a leading dot, without one, and case-insensitively", () => {
    const m = sample();
    expect(serverForExtension(m, ".ts")?.language).toBe("typescript");
    expect(serverForExtension(m, "ts")?.language).toBe("typescript");
    expect(serverForExtension(m, ".TSX")?.language).toBe("typescript");
    expect(serverForExtension(m, "hpp")?.language).toBe("cpp");
    expect(serverForExtension(m, ".unknown")).toBeUndefined();
  });
});

describe("serverForLanguageId", () => {
  it("matches by languageId and by the language key", () => {
    const m = sample();
    expect(serverForLanguageId(m, "typescript")?.language).toBe("typescript");
    // matches by languageId
    expect(serverForLanguageId(m, "cpp-lang")?.language).toBe("cpp");
    // matches by language key even though it differs from languageId
    expect(serverForLanguageId(m, "cpp")?.languageId).toBe("cpp-lang");
    expect(serverForLanguageId(m, "nope")).toBeUndefined();
  });
});

describe("languageIdForPath", () => {
  it("maps by extension, else undefined", () => {
    const m = sample();
    expect(languageIdForPath(m, "foo.ts")).toBe("typescript");
    expect(languageIdForPath(m, "a/b/foo.TSX")).toBe("typescript");
    expect(languageIdForPath(m, "foo.unknown")).toBeUndefined();
    expect(languageIdForPath(m, "Makefile")).toBeUndefined();
  });
});

// --- path layout -----------------------------------------------------------

describe("path helpers", () => {
  it("committed writer paths lay out under .aiui/lsp", () => {
    const root = "/home/proj";
    expect(lspDir(root)).toBe(join(root, ".aiui", "lsp"));
    expect(manifestPath(root)).toBe(join(root, ".aiui", "lsp", "manifest.json"));
    // cache dir is the gitignored home of the automatic bootstrap
    expect(cacheLspDir(root)).toBe(join(root, ".aiui-cache", "lsp"));
    // with no manifest on disk anywhere, launcherPath resolves to the committed dir
    expect(launcherPath(root, sample().servers[0])).toBe(
      join(root, ".aiui", "lsp", "typescript/launch"),
    );
  });
});

// --- loadManifest ----------------------------------------------------------

describe("loadManifest", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "aiui-lsp-manifest-"));
  });

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("returns undefined when there is no manifest", () => {
    expect(loadManifest(root)).toBeUndefined();
  });

  it("round-trips a written manifest", () => {
    writeManifest(root, sample());
    expect(loadManifest(root)).toEqual(sample());
  });

  it("throws on unparseable JSON", () => {
    mkdirSync(lspDir(root), { recursive: true });
    writeFileSync(manifestPath(root), "{ not json", "utf8");
    expect(() => loadManifest(root)).toThrow();
  });

  it("throws (with the file path) on a present-but-invalid manifest", () => {
    mkdirSync(lspDir(root), { recursive: true });
    writeFileSync(manifestPath(root), JSON.stringify({ version: 2, servers: [] }), "utf8");
    expect(() => loadManifest(root)).toThrow(/unsupported version/);
  });

  // --- committed .aiui/lsp preference + .aiui-cache/lsp bootstrap fallback ---

  const writeCacheManifest = (m: LspManifest): void => {
    mkdirSync(cacheLspDir(root), { recursive: true });
    writeFileSync(join(cacheLspDir(root), "manifest.json"), JSON.stringify(m), "utf8");
  };

  it("reads a bootstrapped .aiui-cache/lsp manifest when there is no committed one", () => {
    const bootstrapped: LspManifest = {
      version: 1,
      servers: [{ language: "python", languageId: "python", extensions: [".py"], launcher: "l" }],
    };
    writeCacheManifest(bootstrapped);
    expect(loadManifest(root)).toEqual(bootstrapped);
    // and the launcher resolves against the cache dir it was found in
    expect(launcherPath(root, bootstrapped.servers[0])).toBe(join(cacheLspDir(root), "l"));
  });

  it("prefers the committed .aiui/lsp manifest over a bootstrapped one", () => {
    writeCacheManifest({
      version: 1,
      servers: [{ language: "python", languageId: "python", extensions: [".py"], launcher: "l" }],
    });
    // committed manifest wins
    writeManifest(root, sample());
    expect(loadManifest(root)).toEqual(sample());
    expect(launcherPath(root, sample().servers[0])).toBe(join(lspDir(root), "typescript/launch"));
  });
});

describe("resolveLspDir", () => {
  let root = "";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "aiui-lsp-resolve-"));
  });
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("returns the committed dir when nothing is on disk", () => {
    expect(resolveLspDir(root)).toBe(lspDir(root));
  });

  it("returns the cache dir when only it has a manifest", () => {
    mkdirSync(cacheLspDir(root), { recursive: true });
    writeFileSync(join(cacheLspDir(root), "manifest.json"), JSON.stringify(sample()), "utf8");
    expect(resolveLspDir(root)).toBe(cacheLspDir(root));
  });

  it("prefers the committed dir when both have a manifest", () => {
    mkdirSync(cacheLspDir(root), { recursive: true });
    writeFileSync(join(cacheLspDir(root), "manifest.json"), JSON.stringify(sample()), "utf8");
    writeManifest(root, sample());
    expect(resolveLspDir(root)).toBe(lspDir(root));
  });
});
