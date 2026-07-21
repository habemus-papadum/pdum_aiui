/**
 * Was a package obtained as an editable **source checkout** (this monorepo) or
 * **installed** from a published tarball? `resolvePackageCli` (in the aiui CLI)
 * uses this to decide how to spawn a workspace CLI: through tsx straight from
 * `src/` in a dev checkout, or plain `node` on `dist/` once installed.
 *
 * The signal is a filesystem fact, not an env var: a dev manifest points `main`
 * at `./src/index.ts`, and `pnpm pack`/`publish` swap in the `publishConfig`
 * overrides (`./dist/index.js`) at pack time — so whether `main` reaches into
 * `src/` tells checkout from tarball exactly. (The old signal — "still carries
 * a `src/` folder" — died when published packages started shipping `src/`
 * alongside `dist/` for sourcemap/declarationMap back-references.) Locate a
 * package's root with {@link packageRoot}, then ask {@link runningFromSource}
 * about it — or use {@link packageFromSource} for both in one call.
 */
import { existsSync, readFileSync } from "node:fs";
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
 * Whether a package directory is an editable source checkout (its manifest's
 * `main` still points into `src/`, i.e. the publishConfig swap never ran)
 * rather than an installed tarball (whose `main` points at `dist/`). Pass the
 * package's own root, e.g. from {@link packageRoot}.
 */
export function runningFromSource(packageDir: string): boolean {
  const manifestPath = join(packageDir, "package.json");
  if (!existsSync(manifestPath)) {
    return false;
  }
  const pkg = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    main?: string;
    module?: string;
    types?: string;
  };
  const entry = pkg.main ?? pkg.module ?? pkg.types;
  return typeof entry === "string" && (/(^|\/)src\//.test(entry) || /\.tsx?$/.test(entry));
}

/**
 * {@link runningFromSource} for a package resolved by name — the common case
 * ("is `@habemus-papadum/aiui-intent-client` a source checkout here?").
 */
export function packageFromSource(packageName: string): boolean {
  return runningFromSource(packageRoot(packageName));
}
