// Shared helpers for the two scaffolders — scripts/new-package.mjs (plain node)
// and scripts/new-demo.ts (tsx). Plain ESM with JSDoc types is the ONLY dialect
// both can import: plain node cannot load a .ts, and one stray TS annotation
// here would break `node scripts/new-package.mjs`; tsx loads a .mjs fine. Keep
// it that way — types travel as JSDoc, never as syntax.

import { existsSync, globSync, readdirSync, readFileSync } from "node:fs";
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
 * The `packages:` globs of pnpm-workspace.yaml (list form only; the file is
 * ours and keeps that shape).
 * @returns {string[]}
 */
function workspaceGlobs() {
  const text = readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8");
  const globs = [];
  let inPackages = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "");
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    const match = line.match(/^\s*-\s*['"]?([^'"]+?)['"]?\s*$/);
    if (match) {
      globs.push(match[1]);
    } else if (line.trim() !== "" && !/^\s/.test(line)) {
      inPackages = false;
    }
  }
  return globs;
}

/**
 * Workspace member name → the floor a sibling declares on it. ship releases
 * each package on its own version; a consumer in this workspace writes
 * `workspace:>=X.Y.Z`, where X.Y.Z is the member's last release (its manifest
 * version minus the `+dev` marker) or `0.0.0` for a private member, which is
 * never released. pnpm links the checkout during development and writes the
 * plain floor when it publishes.
 * @returns {Map<string, string>}
 */
export function workspaceFloors() {
  const floors = new Map();
  for (const glob of workspaceGlobs()) {
    for (const dir of globSync(glob, { cwd: repoRoot })) {
      const file = join(repoRoot, dir, "package.json");
      if (!existsSync(file)) continue;
      const pkg = JSON.parse(readFileSync(file, "utf8"));
      const release = pkg.private === true ? "0.0.0" : String(pkg.version).replace(/\+dev$/, "");
      floors.set(pkg.name, `workspace:>=${release}`);
    }
  }
  return floors;
}

/**
 * Dependency name → catalog reference, read from the root pnpm-workspace.yaml:
 * `"catalog:"` for default-catalog entries, `"catalog:<group>"` for named
 * groups (today: `solid`).
 *
 * A deliberately minimal parse of OUR OWN file rather than a YAML dependency:
 * catalog entries are single `name: version` lines at fixed indentation, and
 * this helper only needs the names. If the catalogs ever grow shapes this
 * cannot read, keep the entries simple rather than teaching this parser YAML.
 * @returns {Map<string, string>}
 */
export function catalogRefs() {
  const text = readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8");
  const refs = new Map();
  /** @type {"catalog" | "catalogs" | null} */
  let section = null;
  let group = null;
  for (const line of text.split("\n")) {
    if (/^\S/.test(line)) {
      section = line.startsWith("catalog:")
        ? "catalog"
        : line.startsWith("catalogs:")
          ? "catalogs"
          : null;
      group = null;
      continue;
    }
    const stripped = line.trim();
    if (!section || !stripped || stripped.startsWith("#")) continue;
    const m = /^("?)([^"]+)\1:(.*)$/.exec(stripped);
    if (!m) continue;
    const key = m[2];
    const indent = line.length - line.trimStart().length;
    if (section === "catalog" && indent === 2) {
      refs.set(key, "catalog:");
    } else if (section === "catalogs" && indent === 2 && m[3].trim() === "") {
      group = key;
    } else if (section === "catalogs" && group && indent >= 4) {
      refs.set(key, `catalog:${group}`);
    }
  }
  return refs;
}

/**
 * The repo URL comes from the root package.json's `repository` field — the one
 * place it is declared; a package's own copy may be blank (aibr's is) — and the
 * npm scope from the first existing scoped package under packages/. Every
 * package shares one scope, so any of them will do — reading the first one
 * tolerates any single package being absent or renamed.
 * @returns {{ scope: string; repoUrl: string }}
 */
export function deriveContext() {
  const root = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const repoUrl = root.repository?.url;
  if (typeof repoUrl !== "string" || repoUrl === "") {
    return fail("the root package.json has no repository.url to stamp on the scaffold");
  }
  const packagesDir = join(repoRoot, "packages");
  const dirs = existsSync(packagesDir)
    ? readdirSync(packagesDir).filter((d) => existsSync(join(packagesDir, d, "package.json")))
    : [];
  for (const dir of dirs) {
    const pkg = JSON.parse(readFileSync(join(packagesDir, dir, "package.json"), "utf8"));
    const scope = pkg.name?.startsWith("@") ? pkg.name.split("/")[0] : "";
    if (scope) {
      return { scope, repoUrl };
    }
  }
  return fail("no existing package to infer the npm scope from — create packages/* first");
}
