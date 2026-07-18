// Shared helpers for the two scaffolders — scripts/new-package.mjs (plain node)
// and scripts/new-demo.ts (tsx). Plain ESM with JSDoc types is the ONLY dialect
// both can import: plain node cannot load a .ts, and one stray TS annotation
// here would break `node scripts/new-package.mjs`; tsx loads a .mjs fine. Keep
// it that way — types travel as JSDoc, never as syntax.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path to the scripts/ directory (this file lives in scripts/lib/). */
export const scriptsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Absolute path to the repo root. */
export const repoRoot = resolve(scriptsDir, "..");

/**
 * Print an error to stderr and exit non-zero. Typed `never` so a caller's
 * control-flow narrowing (e.g. `if (!name) fail(...)`) still holds after it.
 * @param {string} message
 * @returns {never}
 */
export function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

/**
 * Normalize a name to a lowercase, dash-separated slug.
 * @param {string} name
 * @returns {string}
 */
export function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The single lockstep version every workspace member must carry, read from the
 * shared versioning tool.
 * @returns {string}
 */
export function currentVersion() {
  return execFileSync("node", [join(scriptsDir, "versioning.mjs"), "current"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
}

/**
 * Infer the npm scope and repo URL from the first existing scoped package under
 * packages/. Output-identical to reading packages/aiui directly as long as every
 * package shares one scope and repo URL (as they do), while tolerating that
 * package being absent or renamed.
 * @returns {{ scope: string; repoUrl: string }}
 */
export function deriveContext() {
  const packagesDir = join(repoRoot, "packages");
  const dirs = existsSync(packagesDir)
    ? readdirSync(packagesDir).filter((d) => existsSync(join(packagesDir, d, "package.json")))
    : [];
  for (const dir of dirs) {
    const pkg = JSON.parse(readFileSync(join(packagesDir, dir, "package.json"), "utf8"));
    const scope = pkg.name?.startsWith("@") ? pkg.name.split("/")[0] : "";
    if (scope) {
      return { scope, repoUrl: pkg.repository?.url ?? "" };
    }
  }
  return fail("no existing package to infer the npm scope from — create packages/* first");
}
