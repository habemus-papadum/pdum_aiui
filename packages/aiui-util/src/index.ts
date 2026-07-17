/**
 * Shared utilities for the aiui packages: cache directories, environment
 * detection (CI / SSH / headless), and the session-browser plumbing that
 * dev-server sidecars build their browser auto-open on.
 *
 * @packageDocumentation
 */

export * from "./browser";
export * from "./environment";
export * from "./extension";
export * from "./provenance";
export * from "./socket-url";

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** The application name — the leaf under the platform cache directory. */
const APP = "aiui";

export interface CacheDirOptions {
  /**
   * Create the directory (recursively) if it doesn't exist. Defaults to `true` —
   * callers generally want a ready-to-use directory back.
   */
  create?: boolean;
}

/**
 * Resolve the cache directory for aiui, creating it by default.
 *
 * Resolution order:
 * 1. `$AIUI_CACHE` — an explicit override; used verbatim as the aiui cache root.
 * 2. `$XDG_CACHE_HOME/aiui` — honoring the XDG Base Directory spec (the variable
 *    is ignored unless it's an absolute path, per the spec).
 * 3. `~/.cache/aiui` — the XDG default.
 *
 * Pass `namespace` to carve out a subdirectory for a particular kind of cached
 * data, e.g. `cacheDir("claude")` → `~/.cache/aiui/claude`. Different callers
 * cache different things, so each should pick its own namespace rather than
 * writing into the shared root.
 *
 * @example
 * const dir = cacheDir("screenshots"); // created, ready to write into
 * const dir = cacheDir("claude", { create: false }); // resolve the path only
 */
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
