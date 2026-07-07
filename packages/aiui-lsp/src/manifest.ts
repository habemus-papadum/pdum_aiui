/**
 * manifest.ts — the descriptor format the channel/reader reads to know how to
 * launch and proxy each project's language servers.
 *
 * The shape chosen (see the `aiui setup-lsp` design): a **thin index** of data
 * (`manifest.json`) that points at **executable launchers** (one per language).
 * The messy, project-specific "how do I actually start this server" logic lives
 * in the launcher — an executable Claude Code writes and *tests* — so the index
 * stays trivial data and nothing has to express venv activation / compile-db
 * paths / env wrangling as JSON.
 *
 * Layout, per project:
 *
 *   .aiui/lsp/
 *     manifest.json          # this file's {@link LspManifest}
 *     <language>/launch      # executable: speaks LSP on stdio for this project
 *     <language>/SETUP.md     # human-readable "how it was set up + test results"
 *
 * `.aiui/lsp/` is **committable**: the launchers are portable (they resolve their
 * server from the project's own `node_modules`/venv at runtime, no absolute
 * machine paths), so a clone + install yields a working reader with no
 * `aiui setup-lsp` step. Setups written before the relocation lived under the
 * gitignored `.aiui-cache/lsp/`; reading still falls back there (see
 * {@link resolveLspDir}) so old checkouts keep working.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Legacy project-local cache dir (pre-relocation). LSP setup used to live under
 * `<root>/.aiui-cache/lsp/`; it is now read-only back-compat — reads fall back to
 * it, writes go to the canonical {@link PROJECT_DIRNAME}. */
export const PROJECT_CACHE_DIRNAME = ".aiui-cache";
/** The committable project dir that holds the canonical LSP setup (`.aiui/`). */
export const PROJECT_DIRNAME = ".aiui";
/** Subdirectory (of `.aiui`, or the legacy `.aiui-cache`) holding the LSP files. */
export const LSP_SUBDIR = "lsp";
export const MANIFEST_FILENAME = "manifest.json";

/** Result of a `probe` self-test, recorded so a human/agent can see it was verified. */
export interface LspVerification {
  /** ISO timestamp of the probe. */
  at: string;
  /** LSP operations exercised (e.g. `["initialize","hover","documentSymbol"]`). */
  ops: string[];
  ok: boolean;
  note?: string;
}

/** One configured language server. */
export interface LspServerEntry {
  /** Human/registry key for the language (e.g. `python`, `cpp`, `lean4`). */
  language: string;
  /** LSP + Monaco language id the client tags documents with (e.g. `typescript`). */
  languageId: string;
  /** File extensions this server owns, dot-prefixed (`.py`, `.ts`, `.hpp`). */
  extensions: string[];
  /** Path to the executable launcher, RELATIVE to the lsp dir (e.g. `python/launch`). */
  launcher: string;
  /** Human label (e.g. `pyright 1.1.411`). */
  name?: string;
  /** Relative path to the human-readable setup doc (e.g. `python/SETUP.md`). */
  doc?: string;
  /** `initializationOptions` to send in the `initialize` request, if any. */
  initializationOptions?: Record<string, unknown>;
  /** The last self-test result, if this entry has been probed. */
  verified?: LspVerification;
}

export interface LspManifest {
  version: 1;
  createdAt?: string;
  servers: LspServerEntry[];
}

/** The canonical (write/default) LSP dir: `<projectRoot>/.aiui/lsp`. Writers use
 * this; reads tolerate the legacy location too (see {@link resolveLspDir}). */
export function lspDir(projectRoot: string): string {
  return join(projectRoot, PROJECT_DIRNAME, LSP_SUBDIR);
}

/** The legacy LSP dir: `<projectRoot>/.aiui-cache/lsp` (read-only back-compat). */
export function legacyLspDir(projectRoot: string): string {
  return join(projectRoot, PROJECT_CACHE_DIRNAME, LSP_SUBDIR);
}

/**
 * The LSP dir to **read** from. Prefers the canonical `.aiui/lsp` when it holds a
 * manifest; otherwise falls back to the legacy `.aiui-cache/lsp` when THAT holds
 * one (so a setup written before the relocation still resolves); otherwise
 * returns the canonical dir (where a fresh setup will be written). Writers should
 * use {@link lspDir} directly — new setups always land in `.aiui/lsp`.
 */
export function resolveLspDir(projectRoot: string): string {
  const canonical = lspDir(projectRoot);
  if (existsSync(join(canonical, MANIFEST_FILENAME))) return canonical;
  const legacy = legacyLspDir(projectRoot);
  if (existsSync(join(legacy, MANIFEST_FILENAME))) return legacy;
  return canonical;
}

/** Canonical manifest path (writers): `<projectRoot>/.aiui/lsp/manifest.json`.
 * Reads resolve via {@link resolveLspDir}, honoring the legacy fallback. */
export function manifestPath(projectRoot: string): string {
  return join(lspDir(projectRoot), MANIFEST_FILENAME);
}

/** Absolute path to an entry's executable launcher, resolved against the dir the
 * manifest was actually found in (so a legacy `.aiui-cache/lsp` setup spawns from
 * there, and a canonical `.aiui/lsp` one from there). */
export function launcherPath(projectRoot: string, entry: LspServerEntry): string {
  return join(resolveLspDir(projectRoot), entry.launcher);
}

/** Read + parse + validate the manifest; `undefined` if it doesn't exist.
 * Prefers `.aiui/lsp`, falls back to the legacy `.aiui-cache/lsp` (see
 * {@link resolveLspDir}). Throws only on a present-but-corrupt manifest (a loud,
 * actionable failure). */
export function loadManifest(projectRoot: string): LspManifest | undefined {
  const path = join(resolveLspDir(projectRoot), MANIFEST_FILENAME);
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return validateManifest(parsed, path);
}

export function validateManifest(parsed: unknown, source = "<manifest>"): LspManifest {
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`${source}: not an object`);
  }
  const m = parsed as Record<string, unknown>;
  if (m.version !== 1) throw new Error(`${source}: unsupported version ${String(m.version)}`);
  if (!Array.isArray(m.servers)) throw new Error(`${source}: "servers" must be an array`);
  const servers = m.servers.map((s, i) => validateEntry(s, `${source}.servers[${i}]`));
  return {
    version: 1,
    ...(typeof m.createdAt === "string" ? { createdAt: m.createdAt } : {}),
    servers,
  };
}

function validateEntry(s: unknown, where: string): LspServerEntry {
  if (typeof s !== "object" || s === null) throw new Error(`${where}: not an object`);
  const e = s as Record<string, unknown>;
  const str = (k: string): string => {
    if (typeof e[k] !== "string" || !e[k])
      throw new Error(`${where}.${k}: expected non-empty string`);
    return e[k] as string;
  };
  if (!Array.isArray(e.extensions) || e.extensions.some((x) => typeof x !== "string")) {
    throw new Error(`${where}.extensions: expected string[]`);
  }
  return {
    language: str("language"),
    languageId: str("languageId"),
    extensions: e.extensions as string[],
    launcher: str("launcher"),
    ...(typeof e.name === "string" ? { name: e.name } : {}),
    ...(typeof e.doc === "string" ? { doc: e.doc } : {}),
    ...(isRecord(e.initializationOptions)
      ? { initializationOptions: e.initializationOptions }
      : {}),
    ...(isRecord(e.verified) ? { verified: e.verified as unknown as LspVerification } : {}),
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function serverForLanguageId(
  m: LspManifest,
  languageId: string,
): LspServerEntry | undefined {
  return m.servers.find((s) => s.languageId === languageId || s.language === languageId);
}

/** `.py` → the python server, etc. `ext` may be given with or without the dot. */
export function serverForExtension(m: LspManifest, ext: string): LspServerEntry | undefined {
  const dotted = ext.startsWith(".") ? ext : `.${ext}`;
  return m.servers.find((s) => s.extensions.includes(dotted.toLowerCase()));
}

/** The languageId that owns a path's extension, or undefined if unmanaged. */
export function languageIdForPath(m: LspManifest, path: string): string | undefined {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return undefined;
  return serverForExtension(m, path.slice(dot).toLowerCase())?.languageId;
}
