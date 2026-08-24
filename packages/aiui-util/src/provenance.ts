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
import { fileURLToPath } from "node:url";

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

/** A module asking about the package IT LIVES IN (see {@link ownPackageRoot}). */
export interface SelfProvenanceOptions {
  /** The calling module's `import.meta.url`, verbatim. */
  importMetaUrl: string;
  /** The calling package's published name — the walk-up match guard, so a
   * bundled vantage (whose nearest manifest is the CONSUMER's) never
   * misreports itself as some other package. */
  packageName: string;
}

/**
 * Package root for a module asking about ITSELF — the resolution-robust
 * variant of {@link packageRoot}, which anchors at THIS package (aiui-util)
 * and so answers by-name questions from a vantage the asker never chose.
 * That vantage broke live (2026-08-24): under pnpm's strict layout a
 * workspace package is invisible to a sibling's `node_modules` chain, and
 * whether the lookup still landed turned on an incidental `NODE_PATH`.
 *
 * Two probes, in order:
 *
 *  1. **By name, anchored at the calling module** — covers installed
 *     layouts (the pnpm virtual store places siblings adjacent) and
 *     config-bundle vantages (a Vite config bundle sits in the consuming
 *     app, whose `node_modules` can see the package).
 *  2. **Upward walk from the calling module's path** to the nearest
 *     `package.json` whose `name` MATCHES — covers the source checkout,
 *     where a workspace package cannot see itself by name at all. The name
 *     guard is what keeps a bundled vantage honest: the consumer's own
 *     manifest doesn't match, so the walk keeps going instead of lying.
 *
 * Returns undefined when neither lands — the caller picks its safe default
 * rather than crashing (the failure that motivated this was a dev server
 * 500ing every page load).
 */
export function ownPackageRoot(options: SelfProvenanceOptions): string | undefined {
  const { importMetaUrl, packageName } = options;
  try {
    const anchored = createRequire(importMetaUrl);
    const segments = packageName.split("/");
    for (const base of anchored.resolve.paths(packageName) ?? []) {
      const manifest = join(base, ...segments, "package.json");
      if (existsSync(manifest)) {
        return dirname(manifest);
      }
    }
  } catch {
    // fall through to the walk
  }
  try {
    let dir = dirname(fileURLToPath(importMetaUrl));
    for (;;) {
      const manifest = join(dir, "package.json");
      if (existsSync(manifest)) {
        const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string };
        if (pkg.name === packageName) {
          return dir;
        }
      }
      const parent = dirname(dir);
      if (parent === dir) {
        return undefined;
      }
      dir = parent;
    }
  } catch {
    return undefined;
  }
}
