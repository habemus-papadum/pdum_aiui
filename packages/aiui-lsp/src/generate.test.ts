import {
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
import { ensureDefaultManifest, provisionServer, writeLauncher, writeManifest } from "./generate";
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

  it("emits portable launchers — no absolute machine paths, project-relative server", () => {
    writeFileSync(join(root, "a.py"), "x = 1\n");
    writeFileSync(join(root, "b.ts"), "export const y = 1;\n");
    const m = ensureDefaultManifest(root, { now: () => new Date(0) });

    for (const s of m.servers) {
      const script = readFileSync(launcherPath(root, s), "utf8");
      // computes the project root from the script's own location, three up
      expect(script).toContain('ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"');
      // resolves the server from the project's own node_modules/.bin
      expect(script).toContain('exec "$ROOT/node_modules/.bin/');
      // no absolute machine paths / node path / pnpm store leakage
      expect(script).not.toMatch(/\/Users\/|\/opt\/|\/home\/|\.pnpm/);
      expect(script).not.toContain(process.execPath);
    }
    // the portable TS recipe drops the absolute tsserver path
    const ts = m.servers.find((s) => s.language === "typescript");
    expect(ts?.initializationOptions).toBeUndefined();
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
