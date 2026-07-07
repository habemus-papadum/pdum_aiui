/**
 * generate.ts — write launchers + the manifest to the canonical `.aiui/lsp/`.
 *
 * `writeLauncher` / `writeSetupDoc` / `writeManifest` are the primitives the
 * setup skill uses after it has worked out (and probed) a launcher.
 * `ensureDefaultManifest` is the bootstrap: with no manifest yet, detect the
 * project's well-known languages and provision them from the built-in recipes,
 * so the reader works out of the box while the richer, Claude-authored setup
 * (exotic languages, project-specific config, probe results in the docs) can
 * come later and overwrite it.
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type LspManifest,
  type LspServerEntry,
  loadManifest,
  lspDir,
  MANIFEST_FILENAME,
  manifestPath,
  resolveLspDir,
} from "./manifest";
import { type BuiltLauncher, detectLanguages, PROVIDERS } from "./providers";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Write an executable launcher at `<lspDir>/<relPath>` (chmod 0755). */
export function writeLauncher(projectRoot: string, relPath: string, script: string): string {
  const abs = join(lspDir(projectRoot), relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, script, "utf8");
  chmodSync(abs, 0o755);
  return abs;
}

/** Write a human-readable doc at `<lspDir>/<relPath>`. */
export function writeSetupDoc(projectRoot: string, relPath: string, markdown: string): string {
  const abs = join(lspDir(projectRoot), relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, markdown, "utf8");
  return abs;
}

/** Write (or overwrite) the manifest index. */
export function writeManifest(projectRoot: string, manifest: LspManifest): string {
  const path = manifestPath(projectRoot);
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
}

/**
 * Return the existing manifest, or bootstrap one from the built-in recipes for
 * whatever well-known languages the project contains. A language whose server
 * isn't installed is logged and skipped (the manifest still lists the others).
 */
export function ensureDefaultManifest(projectRoot: string, opts: EnsureOptions = {}): LspManifest {
  const log = opts.onLog ?? (() => {});
  if (!opts.force) {
    const existing = loadManifest(projectRoot);
    if (existing) return existing;
  }

  const now = (opts.now ?? (() => new Date()))();
  const servers: LspServerEntry[] = [];
  for (const key of detectLanguages(projectRoot)) {
    try {
      const built = PROVIDERS[key].build(projectRoot);
      servers.push(provisionServer(projectRoot, built, now));
      log(`lsp: provisioned ${built.language} — ${built.name}`);
    } catch (err) {
      log(`lsp: skipped ${key} — ${msg(err)}`);
    }
  }
  const manifest: LspManifest = { version: 1, createdAt: now.toISOString(), servers };
  writeManifest(projectRoot, manifest);
  log(`lsp: wrote manifest with ${servers.length} server(s)`);
  return manifest;
}

/** Write a built recipe's launcher + a default SETUP.md and return its entry. */
export function provisionServer(
  projectRoot: string,
  built: BuiltLauncher,
  now: Date,
): LspServerEntry {
  const launcherRel = `${built.language}/launch`;
  const docRel = `${built.language}/SETUP.md`;
  writeLauncher(projectRoot, launcherRel, built.script);
  writeSetupDoc(projectRoot, docRel, defaultSetupDoc(built, now));
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
    "",
  ].join("\n");
}

/** Whether a manifest exists for this project, in either the canonical `.aiui/lsp`
 * or the legacy `.aiui-cache/lsp` (mirrors {@link loadManifest}'s resolution). */
export function hasManifest(projectRoot: string): boolean {
  return existsSync(join(resolveLspDir(projectRoot), MANIFEST_FILENAME));
}
