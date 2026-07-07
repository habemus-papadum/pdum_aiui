/**
 * generate.ts — write launchers + the manifest for a project's LSP setup.
 *
 * `writeLauncher` / `writeSetupDoc` / `writeManifest` are the primitives the
 * setup skill uses after it has worked out (and probed) a launcher; they write
 * the committed `.aiui/lsp/` unless told otherwise. `ensureDefaultManifest` is
 * the bootstrap: with no manifest yet, detect the project's well-known languages
 * and provision them from the built-in recipes so the reader works out of the
 * box. The bootstrap lands in the **gitignored** `.aiui-cache/lsp/` by default —
 * merely opening the reader must never dirty the working tree with untested,
 * committable launchers; only a deliberate act (`aiui lsp provision`,
 * `aiui setup-lsp`) writes the committed home.
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  cacheLspDir,
  type LspManifest,
  type LspServerEntry,
  loadManifest,
  lspDir,
  MANIFEST_FILENAME,
} from "./manifest";
import { type BuiltLauncher, detectLanguages, PROVIDERS } from "./providers";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Where a write lands: `dir` overrides the committed default (`.aiui/lsp`). */
interface WriteTarget {
  dir?: string;
}

/** Write an executable launcher at `<dir>/<relPath>` (chmod 0755). */
export function writeLauncher(
  projectRoot: string,
  relPath: string,
  script: string,
  target: WriteTarget = {},
): string {
  const abs = join(target.dir ?? lspDir(projectRoot), relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, script, "utf8");
  chmodSync(abs, 0o755);
  return abs;
}

/** Write a human-readable doc at `<dir>/<relPath>`. */
export function writeSetupDoc(
  projectRoot: string,
  relPath: string,
  markdown: string,
  target: WriteTarget = {},
): string {
  const abs = join(target.dir ?? lspDir(projectRoot), relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, markdown, "utf8");
  return abs;
}

/** Write (or overwrite) the manifest index. */
export function writeManifest(
  projectRoot: string,
  manifest: LspManifest,
  target: WriteTarget = {},
): string {
  const path = join(target.dir ?? lspDir(projectRoot), MANIFEST_FILENAME);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return path;
}

export interface EnsureOptions {
  onLog?: (line: string) => void;
  /** Stamp for `createdAt`/docs (injectable for deterministic tests). */
  now?: () => Date;
  /** Force re-provisioning even if a manifest already exists. */
  force?: boolean;
  /**
   * Where a fresh bootstrap lands. `"cache"` (the default) writes the gitignored
   * `.aiui-cache/lsp/` — safe for the implicit path (the reader backend calls
   * this on every mount, and that must never dirty the working tree).
   * `"committed"` writes `.aiui/lsp/` — for the deliberate acts
   * (`aiui lsp provision`).
   */
  home?: "cache" | "committed";
}

/**
 * Return the existing manifest, or bootstrap one from the built-in recipes for
 * whatever well-known languages the project contains. A language whose server
 * isn't installed is logged and skipped (the manifest still lists the others).
 */
export function ensureDefaultManifest(projectRoot: string, opts: EnsureOptions = {}): LspManifest {
  const log = opts.onLog ?? (() => {});
  const home = opts.home ?? "cache";
  const dir = home === "committed" ? lspDir(projectRoot) : cacheLspDir(projectRoot);
  if (!opts.force) {
    // For a cache bootstrap any existing setup serves; a deliberate committed
    // provision is only satisfied by a committed manifest (an earlier bootstrap
    // in the cache must not block it).
    const satisfied =
      home === "cache" || existsSync(join(lspDir(projectRoot), MANIFEST_FILENAME));
    if (satisfied) {
      const existing = loadManifest(projectRoot);
      if (existing) return existing;
    }
  }

  const now = (opts.now ?? (() => new Date()))();
  const servers: LspServerEntry[] = [];
  for (const key of detectLanguages(projectRoot)) {
    try {
      const built = PROVIDERS[key].build(projectRoot);
      servers.push(provisionServer(projectRoot, built, now, { dir }));
      log(`lsp: provisioned ${built.language} — ${built.name}`);
    } catch (err) {
      log(`lsp: skipped ${key} — ${msg(err)}`);
    }
  }
  const manifest: LspManifest = { version: 1, createdAt: now.toISOString(), servers };
  writeManifest(projectRoot, manifest, { dir });
  log(`lsp: wrote manifest with ${servers.length} server(s) (${home})`);
  return manifest;
}

/** Write a built recipe's launcher + a default SETUP.md and return its entry. */
export function provisionServer(
  projectRoot: string,
  built: BuiltLauncher,
  now: Date,
  target: WriteTarget = {},
): LspServerEntry {
  const launcherRel = `${built.language}/launch`;
  const docRel = `${built.language}/SETUP.md`;
  writeLauncher(projectRoot, launcherRel, built.script, target);
  writeSetupDoc(projectRoot, docRel, defaultSetupDoc(built, now), target);
  return {
    language: built.language,
    languageId: built.languageId,
    extensions: built.extensions,
    launcher: launcherRel,
    name: built.name,
    doc: docRel,
    ...(built.initializationOptions ? { initializationOptions: built.initializationOptions } : {}),
  };
}

function defaultSetupDoc(built: BuiltLauncher, now: Date): string {
  return [
    `# LSP setup — ${built.language}`,
    "",
    `- **Server:** ${built.name}`,
    `- **Language id:** \`${built.languageId}\``,
    `- **Extensions:** ${built.extensions.map((e) => `\`${e}\``).join(", ")}`,
    `- **Provisioned:** ${now.toISOString()} (built-in recipe)`,
    "",
    "The launcher next to this file (`launch`) is an executable that speaks LSP on",
    "stdio. The channel/reader spawns it with the project root as cwd and pipes",
    "bytes to the browser's LSP client — nothing rewrites LSP semantics.",
    "",
    "Re-run `aiui setup-lsp` to re-provision, add languages, or replace this with a",
    "hand-tuned launcher (e.g. to activate a venv or point at a compile database).",
    "A setup under `.aiui-cache/lsp/` was bootstrapped automatically and is",
    "gitignored; `aiui lsp provision` records a committed one under `.aiui/lsp/`.",
    "",
  ].join("\n");
}
