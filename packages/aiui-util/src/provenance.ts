/**
 * Was a package obtained as an editable **source checkout** (this monorepo) or
 * **installed** from a published tarball? `resolvePackageCli` (in the aiui CLI)
 * uses this to decide how to spawn a workspace CLI: through tsx straight from
 * `src/` in a dev checkout, or plain `node` on `dist/` once installed.
 *
 * The signal is a filesystem fact, not an env var: a published tarball ships
 * only its `dist/` (the `files` allowlist excludes `src/`), so a package directory
 * that still carries a `src/` folder is a dev checkout. Locate a package's root
 * with {@link packageRoot}, then ask {@link runningFromSource} about it — or use
 * {@link packageFromSource} for both in one call.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// Resolve modules the way this package would at runtime.
const nodeRequire = createRequire(import.meta.url);

/**
 * Absolute root directory of an installed (or workspace-linked) dependency.
 *
 * Rather than resolve the package *through* the module system — which would hit
 * its `exports` map (forcing a built `dist/`, and normally blocking access to
 * `package.json`) — we ask Node for the `node_modules` dirs it would search and
 * read `package.json` straight off disk. This needs nothing special from the
 * target package (no `exports` entry) and works even when it has not been built,
 * so dev iteration requires no compile step.
 */
export function packageRoot(packageName: string): string {
  const segments = packageName.split("/");
  for (const base of nodeRequire.resolve.paths(packageName) ?? []) {
    const manifest = join(base, ...segments, "package.json");
    if (existsSync(manifest)) {
      return dirname(manifest);
    }
  }
  throw new Error(`could not locate the "${packageName}" package (is it installed?)`);
}

/**
 * Whether a package directory is an editable source checkout (it still carries
 * a `src/` folder) rather than an installed tarball (which ships only `dist/`).
 * Pass the package's own root, e.g. from {@link packageRoot}.
 */
export function runningFromSource(packageDir: string): boolean {
  return existsSync(join(packageDir, "src"));
}

/**
 * {@link runningFromSource} for a package resolved by name — the common case
 * ("is `@habemus-papadum/aiui-dev-overlay` a source checkout here?").
 */
export function packageFromSource(packageName: string): boolean {
  return runningFromSource(packageRoot(packageName));
}
