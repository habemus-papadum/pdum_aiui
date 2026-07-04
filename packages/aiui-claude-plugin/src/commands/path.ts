import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve the absolute path to the bundled `marketplace/` directory.
 *
 * Works both when installed from npm (the built CLI sits in `dist/`, with
 * `marketplace/` shipped alongside it at the package root) and in local dev
 * (the CLI runs from `src/`). Rather than assume a fixed depth from this
 * module, we walk up the directory tree until we find the `marketplace/` dir
 * that holds the marketplace manifest — so the same code resolves correctly
 * from `dist/`, `src/commands/`, or anywhere else the module is loaded from.
 */
export function marketplaceDir(): string {
  const start = dirname(fileURLToPath(import.meta.url));
  let dir = start;
  let parent = dirname(dir);
  while (dir !== parent) {
    const candidate = resolve(dir, "marketplace");
    if (existsSync(resolve(candidate, ".claude-plugin", "marketplace.json"))) {
      return candidate;
    }
    dir = parent;
    parent = dirname(dir);
  }
  throw new Error(
    `could not locate the bundled marketplace/ directory (searched up from ${start})`,
  );
}

/** The plugin names the bundled marketplace declares, in manifest order. */
export function listPlugins(): string[] {
  const manifest = JSON.parse(
    readFileSync(resolve(marketplaceDir(), ".claude-plugin", "marketplace.json"), "utf8"),
  ) as { plugins?: Array<{ name: string }> };
  return (manifest.plugins ?? []).map((p) => p.name);
}

/**
 * Resolve one bundled plugin's directory (what `claude --plugin-dir` takes).
 * Plugins load directly this way — the marketplace manifest exists for
 * marketplace-based installs later, not as a required indirection.
 */
export function pluginDir(name: string): string {
  const dir = resolve(marketplaceDir(), "plugins", name);
  if (!existsSync(resolve(dir, ".claude-plugin", "plugin.json"))) {
    throw new Error(`no bundled plugin named "${name}" — available: ${listPlugins().join(", ")}`);
  }
  return dir;
}

/** `path [plugin]`: print the marketplace dir, or one plugin's dir. */
export function runPath(plugin?: string): void {
  console.log(plugin === undefined ? marketplaceDir() : pluginDir(plugin));
}

/** `list`: print the bundled plugin names, one per line. */
export function runList(): void {
  for (const name of listPlugins()) {
    console.log(name);
  }
}
