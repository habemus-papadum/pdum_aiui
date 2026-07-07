import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BOOTSTRAP_GENERATION,
  ensureDefaultManifest,
  provisionServer,
  writeLauncher,
  writeManifest,
} from "./generate";
import { type LspManifest, launcherPath, loadManifest } from "./manifest";
import { detectLanguages } from "./providers";

// Owner-execute bit; the launcher must be spawnable.
const isExecutable = (p: string): boolean => (statSync(p).mode & 0o100) === 0o100;

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aiui-lsp-generate-"));
});
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

// --- writeLauncher ---------------------------------------------------------

describe("writeLauncher", () => {
  it("writes the file and makes it executable", () => {
    const abs = writeLauncher(root, "python/launch", "#!/usr/bin/env bash\necho hi\n");
    expect(existsSync(abs)).toBe(true);
    expect(isExecutable(abs)).toBe(true);
  });
});

// --- writeManifest round-trip ----------------------------------------------

describe("writeManifest + loadManifest", () => {
  it("round-trips", () => {
    const manifest: LspManifest = {
      version: 1,
      createdAt: "2026-07-06T00:00:00.000Z",
      servers: [
        {
          language: "python",
          languageId: "python",
          extensions: [".py"],
          launcher: "python/launch",
          name: "pyright 1.1.411",
        },
      ],
    };
    writeManifest(root, manifest);
    expect(loadManifest(root)).toEqual(manifest);
  });
});

// --- provisionServer -------------------------------------------------------

describe("provisionServer", () => {
  it("writes launcher + SETUP.md and returns a manifest entry", () => {
    const entry = provisionServer(
      root,
      {
        language: "python",
        languageId: "python",
        extensions: [".py", ".pyi"],
        script: "#!/usr/bin/env bash\nexec true\n",
        name: "pyright X",
        initializationOptions: { some: "opt" },
      },
      new Date(0),
    );
    expect(entry).toEqual({
      language: "python",
      languageId: "python",
      extensions: [".py", ".pyi"],
      launcher: "python/launch",
      name: "pyright X",
      doc: "python/SETUP.md",
      initializationOptions: { some: "opt" },
    });
    expect(isExecutable(launcherPath(root, entry))).toBe(true);
    expect(existsSync(join(root, ".aiui", "lsp", "python/SETUP.md"))).toBe(true);
  });
});

// --- ensureDefaultManifest (uses the REAL pyright/tsls recipes) -------------

describe("ensureDefaultManifest", () => {
  it("provisions python + typescript for a mixed project", () => {
    writeFileSync(join(root, "a.py"), "x = 1\n");
    writeFileSync(join(root, "b.ts"), "export const y = 1;\n");

    const m = ensureDefaultManifest(root, { now: () => new Date(0) });
    expect(m.servers.map((s) => s.language).sort()).toEqual(["python", "typescript"]);
    expect(m.createdAt).toBe("1970-01-01T00:00:00.000Z");

    for (const s of m.servers) {
      const lp = launcherPath(root, s);
      expect(existsSync(lp)).toBe(true);
      expect(isExecutable(lp)).toBe(true);
    }
  });

  it("cache launchers walk up node_modules/.bin and fall back to the bundled server", () => {
    writeFileSync(join(root, "a.py"), "x = 1\n");
    writeFileSync(join(root, "b.ts"), "export const y = 1;\n");
    const m = ensureDefaultManifest(root, { now: () => new Date(0) });

    for (const s of m.servers) {
      const script = readFileSync(launcherPath(root, s), "utf8");
      // computes the project root from the script's own location, three up
      expect(script).toContain('ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"');
      // resolves the server from the nearest node_modules/.bin at or above ROOT
      expect(script).toContain('BIN="$DIR/node_modules/.bin/');
      // …and, cache-only, falls back to the server bundled with aiui-lsp: an
      // absolute path is deliberate here (the cache is per-machine), and it is
      // what makes the reader work when the project never installed a server.
      expect(script).toContain('exec node "');
    }
    // the portable TS recipe drops the absolute tsserver path
    const ts = m.servers.find((s) => s.language === "typescript");
    expect(ts?.initializationOptions).toBeUndefined();
  });

  it("committed launchers stay portable — no absolute paths, loud exit without a server", () => {
    writeFileSync(join(root, "b.ts"), "export const y = 1;\n");
    // The committed (portable) build requires a project install: fake the bin.
    const binDir = join(root, "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "typescript-language-server"), "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(join(binDir, "typescript-language-server"), 0o755);

    const m = ensureDefaultManifest(root, { now: () => new Date(0), home: "committed" });
    expect(m.servers.map((s) => s.language)).toEqual(["typescript"]);

    const script = readFileSync(launcherPath(root, m.servers[0]), "utf8");
    // no absolute machine paths / node path / pnpm store leakage — committable
    expect(script).not.toMatch(/\/Users\/|\/opt\/|\/home\/|\.pnpm/);
    expect(script).not.toContain(process.execPath);
    // a clone without the dep fails loudly with the install hint, never 126
    expect(script).toContain("exit 127");
    expect(script).toContain("pnpm add -D typescript-language-server");
  });

  it("a committed provision skips a language whose server the project lacks", () => {
    writeFileSync(join(root, "b.ts"), "export const y = 1;\n");
    const logs: string[] = [];
    const m = ensureDefaultManifest(root, {
      now: () => new Date(0),
      home: "committed",
      onLog: (l) => logs.push(l),
    });
    // tmp project has no node_modules/.bin/typescript-language-server anywhere
    // up its (tmpdir) ancestry — a portable launcher could never run, so the
    // recipe must refuse with the actionable hint rather than record it.
    expect(m.servers).toEqual([]);
    expect(logs.some((l) => /skipped typescript.*pnpm add -D/.test(l))).toBe(true);
  });

  // --- the launchers actually run (behavioral, not just textual) -------------

  it("a project's own server install wins over the bundled fallback", () => {
    writeFileSync(join(root, "b.ts"), "export const y = 1;\n");
    const binDir = join(root, "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, "typescript-language-server"),
      '#!/usr/bin/env bash\necho "PROJECT_BIN $@"\n',
    );
    chmodSync(join(binDir, "typescript-language-server"), 0o755);

    const m = ensureDefaultManifest(root, { now: () => new Date(0) });
    const out = execFileSync(launcherPath(root, m.servers[0]), { encoding: "utf8" });
    expect(out).toBe("PROJECT_BIN --stdio\n");
  });

  it("without a project install, the cache launcher execs the bundled server via node", () => {
    writeFileSync(join(root, "b.ts"), "export const y = 1;\n");
    const m = ensureDefaultManifest(root, { now: () => new Date(0) });

    // Put a fake `node` first on PATH: the fallback line must exec it with the
    // absolute entry that was baked at generation time.
    const fakePath = join(root, "fake-path");
    mkdirSync(fakePath, { recursive: true });
    writeFileSync(join(fakePath, "node"), '#!/usr/bin/env bash\necho "NODE $@"\n');
    chmodSync(join(fakePath, "node"), 0o755);

    const out = execFileSync(launcherPath(root, m.servers[0]), {
      encoding: "utf8",
      env: { ...process.env, PATH: `${fakePath}:${process.env.PATH ?? ""}` },
    });
    expect(out).toMatch(/^NODE .*typescript-language-server.* --stdio\n$/);
  });

  // --- generation: stale cache bootstraps re-provision themselves ------------

  it("re-provisions a cache bootstrap from an older generation (no force needed)", () => {
    writeFileSync(join(root, "b.ts"), "export const y = 1;\n");
    const first = ensureDefaultManifest(root, { now: () => new Date(0) });
    expect(first.generation).toBe(BOOTSTRAP_GENERATION);

    // Age the on-disk manifest to the pre-generation format (generation 1
    // launchers assumed the server bin at the project root — broken).
    const { generation: _drop, ...aged } = first;
    writeManifest(root, aged as LspManifest, { dir: join(root, ".aiui-cache", "lsp") });

    const logs: string[] = [];
    const second = ensureDefaultManifest(root, {
      now: () => new Date(60_000),
      onLog: (l) => logs.push(l),
    });
    expect(second.generation).toBe(BOOTSTRAP_GENERATION);
    expect(second.createdAt).toBe("1970-01-01T00:01:00.000Z");
    expect(logs.some((l) => /re-provisioning/.test(l))).toBe(true);
  });

  it("generation never second-guesses a committed setup", () => {
    writeFileSync(join(root, "a.py"), "x = 1\n");
    // A committed manifest with no generation (hand-written / older tool).
    const committed: LspManifest = {
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      servers: [],
    };
    writeManifest(root, committed);
    const bootstrapped = ensureDefaultManifest(root, { now: () => new Date(60_000) });
    expect(bootstrapped).toEqual(committed);
    expect(existsSync(join(root, ".aiui-cache"))).toBe(false);
  });

  it("is idempotent without force, and regenerates with force", () => {
    writeFileSync(join(root, "a.py"), "x = 1\n");
    writeFileSync(join(root, "b.ts"), "export const y = 1;\n");

    const first = ensureDefaultManifest(root, { now: () => new Date(0) });
    // A second call with a *different* clock but no force must return the
    // on-disk manifest untouched (proving it did not re-provision).
    const second = ensureDefaultManifest(root, { now: () => new Date(60_000) });
    expect(second).toEqual(first);
    expect(second.createdAt).toBe(first.createdAt);

    const forced = ensureDefaultManifest(root, { now: () => new Date(60_000), force: true });
    expect(forced.createdAt).toBe("1970-01-01T00:01:00.000Z");
    expect(forced.createdAt).not.toBe(first.createdAt);
  });

  it("provisions only the languages present (graceful single-language)", () => {
    writeFileSync(join(root, "only.py"), "x = 1\n");
    const logs: string[] = [];
    const m = ensureDefaultManifest(root, { now: () => new Date(0), onLog: (l) => logs.push(l) });
    expect(m.servers.map((s) => s.language)).toEqual(["python"]);
    expect(logs.some((l) => /provisioned python/.test(l))).toBe(true);
  });

  // --- the provenance split: implicit bootstrap vs deliberate provision ------

  it("bootstraps into the gitignored cache — never dirties the committable .aiui/", () => {
    writeFileSync(join(root, "a.py"), "x = 1\n");
    ensureDefaultManifest(root, { now: () => new Date(0) });
    expect(existsSync(join(root, ".aiui-cache", "lsp", "manifest.json"))).toBe(true);
    expect(existsSync(join(root, ".aiui"))).toBe(false);
  });

  it("home: 'committed' provisions into .aiui/lsp (the deliberate path)", () => {
    writeFileSync(join(root, "a.py"), "x = 1\n");
    ensureDefaultManifest(root, { now: () => new Date(0), home: "committed" });
    expect(existsSync(join(root, ".aiui", "lsp", "manifest.json"))).toBe(true);
    expect(existsSync(join(root, ".aiui-cache"))).toBe(false);
  });

  it("a committed provision proceeds despite an earlier cache bootstrap (and then wins reads)", () => {
    writeFileSync(join(root, "a.py"), "x = 1\n");
    ensureDefaultManifest(root, { now: () => new Date(0) }); // cache bootstrap
    const committed = ensureDefaultManifest(root, {
      now: () => new Date(60_000),
      home: "committed",
    });
    expect(committed.createdAt).toBe("1970-01-01T00:01:00.000Z");
    expect(existsSync(join(root, ".aiui", "lsp", "manifest.json"))).toBe(true);
    // Reads now prefer the committed manifest.
    expect(loadManifest(root)?.createdAt).toBe(committed.createdAt);
  });

  it("a cache bootstrap defers to an existing committed setup", () => {
    writeFileSync(join(root, "a.py"), "x = 1\n");
    const committed = ensureDefaultManifest(root, { now: () => new Date(0), home: "committed" });
    const bootstrapped = ensureDefaultManifest(root, { now: () => new Date(60_000) });
    expect(bootstrapped).toEqual(committed);
    expect(existsSync(join(root, ".aiui-cache"))).toBe(false);
  });
});

// --- detectLanguages -------------------------------------------------------

describe("detectLanguages", () => {
  it("detects python from a .py file", () => {
    writeFileSync(join(root, "a.py"), "x = 1\n");
    expect(detectLanguages(root)).toEqual(["python"]);
  });

  it("detects typescript from a .ts file", () => {
    writeFileSync(join(root, "a.ts"), "export const x = 1;\n");
    expect(detectLanguages(root)).toEqual(["typescript"]);
  });

  it("detects both, in a stable order", () => {
    writeFileSync(join(root, "a.py"), "x = 1\n");
    writeFileSync(join(root, "a.ts"), "export const x = 1;\n");
    expect(detectLanguages(root)).toEqual(["python", "typescript"]);
  });

  it("skips node_modules/.git/.venv subdirs", () => {
    writeFileSync(join(root, "top.py"), "x = 1\n");
    for (const dir of ["node_modules", ".git", ".venv"]) {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, "hidden.ts"), "export const z = 1;\n");
    }
    // The only .ts files live in skipped dirs, so typescript must NOT appear.
    expect(detectLanguages(root)).toEqual(["python"]);
  });
});
