/**
 * Cache-directory resolution — a deliberate, exact DUPLICATE of
 * `@habemus-papadum/aiui-util`'s `cacheDir` (the one accepted duplication in
 * the registry design: docs/proposals/aiui-registry.md §7). The two must agree
 * byte-for-byte on the resolved path, or this package and the aiui workspace
 * would read different registries. Resolution order:
 *
 *  1. `$AIUI_CACHE` — explicit override, used verbatim as the aiui cache root.
 *  2. `$XDG_CACHE_HOME/aiui` — XDG Base Directory spec (the variable is
 *     ignored unless it's an absolute path, per the spec).
 *  3. `~/.cache/aiui` — the XDG default.
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** The application name — the leaf under the platform cache directory. */
const APP = "aiui";

/** The cache namespace holding registry entry files (`~/.cache/aiui/mcp`). */
const REGISTRY_NAMESPACE = "mcp";

/** The cache namespace holding the agents cache + per-client locks. */
const AGENTS_NAMESPACE = "agents";

export interface CacheDirOptions {
  /**
   * Create the directory (recursively) if it doesn't exist. Defaults to
   * `true`; read paths pass `{ create: false }` so a missing directory can
   * mean "nothing is running" without materializing it as a side effect.
   */
  create?: boolean;
}

/** Resolve the aiui cache directory (optionally a namespace under it). */
export function cacheDir(namespace?: string, options: CacheDirOptions = {}): string {
  const { create = true } = options;
  const dir = namespace ? join(cacheRoot(), namespace) : cacheRoot();
  if (create) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/** Resolve the aiui cache root (no directory creation). */
function cacheRoot(): string {
  const override = process.env.AIUI_CACHE?.trim();
  if (override) {
    return override;
  }

  const xdg = process.env.XDG_CACHE_HOME?.trim();
  const cacheHome = xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".cache");
  return join(cacheHome, APP);
}

/** The directory holding registry entry files (`<pid>.json`). */
export function registryDir(options: CacheDirOptions = {}): string {
  return cacheDir(REGISTRY_NAMESPACE, options);
}

/** The directory holding the shared agents cache and per-client lock files. */
export function agentsDir(options: CacheDirOptions = {}): string {
  return cacheDir(AGENTS_NAMESPACE, options);
}
