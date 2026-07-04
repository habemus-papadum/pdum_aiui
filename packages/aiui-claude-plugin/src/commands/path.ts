import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve the absolute path to the bundled `plugin/` directory.
 *
 * Works both when installed from npm (the built CLI sits in `dist/`, with
 * `plugin/` shipped alongside it at the package root) and in local dev (the CLI
 * runs from `src/`). Rather than assume a fixed depth from this module, we walk
 * up the directory tree until we find the `plugin/` dir that holds the plugin
 * manifest — so the same code resolves correctly from `dist/`, `src/commands/`,
 * or anywhere else the module might be loaded from.
 */
export function pluginDir(): string {
  const start = dirname(fileURLToPath(import.meta.url));
  let dir = start;
  let parent = dirname(dir);
  while (dir !== parent) {
    const candidate = resolve(dir, "plugin");
    if (existsSync(resolve(candidate, ".claude-plugin", "plugin.json"))) {
      return candidate;
    }
    dir = parent;
    parent = dirname(dir);
  }
  throw new Error(`could not locate the bundled plugin/ directory (searched up from ${start})`);
}

/** Print the absolute plugin directory path to stdout. */
export function runPath(): void {
  console.log(pluginDir());
}
