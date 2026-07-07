/**
 * workspace.ts — monorepo awareness for language detection.
 *
 * At a *workspace root* (a pnpm/npm/yarn monorepo), the languages that matter
 * are the ones its **member packages** use — not whatever happens to live
 * elsewhere in the tree. This repo is the motivating case: a top-level
 * `aiui lsp provision` should set up a TypeScript server for `packages/*`, and
 * must NOT be dragged into provisioning Python just because an unrelated
 * `examples/py-demo` project sits in the tree. So {@link detectLanguages} scans
 * the workspace members when there are any, and only falls back to walking the
 * whole tree for a plain (non-workspace) project.
 *
 * We read the workspace globs from `pnpm-workspace.yaml` (`packages:`) or a
 * package.json `workspaces` field, and expand them to the directories that
 * actually contain a `package.json`. The YAML is parsed minimally on purpose —
 * `packages:` is the only key we need, and a hand-rolled reader keeps this
 * published package dependency-free.
 */

import { existsSync, globSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The member package directories of the monorepo rooted at `root` (absolute
 * paths), or `null` when `root` is not a workspace root. A workspace with
 * globs but no resolvable members returns `null` too (treat as non-workspace).
 */
export function workspaceMemberDirs(root: string): string[] | null {
  const globs = workspaceGlobs(root);
  if (!globs || globs.length === 0) return null;
  const dirs = new Set<string>();
  for (const glob of globs) {
    if (glob.startsWith("!")) continue; // exclusion globs — skip (rare)
    let matches: string[];
    try {
      matches = globSync(`${glob}/package.json`, { cwd: root });
    } catch {
      continue;
    }
    for (const m of matches) dirs.add(join(root, dirname(m)));
  }
  return dirs.size ? [...dirs].sort() : null;
}

/** The raw workspace globs declared at `root`, or `null` if it's not a workspace root. */
function workspaceGlobs(root: string): string[] | null {
  const pnpm = join(root, "pnpm-workspace.yaml");
  if (existsSync(pnpm)) {
    try {
      const globs = pnpmPackages(readFileSync(pnpm, "utf8"));
      if (globs.length) return globs;
    } catch {
      /* fall through to package.json */
    }
  }
  const pkgJson = join(root, "package.json");
  if (existsSync(pkgJson)) {
    try {
      const doc = JSON.parse(readFileSync(pkgJson, "utf8")) as {
        workspaces?: string[] | { packages?: string[] };
      };
      const ws = doc.workspaces;
      const arr = Array.isArray(ws) ? ws : Array.isArray(ws?.packages) ? ws.packages : null;
      if (arr) {
        const globs = arr.filter((p): p is string => typeof p === "string");
        if (globs.length) return globs;
      }
    } catch {
      /* not a workspace root */
    }
  }
  return null;
}

/**
 * Minimal parse of `pnpm-workspace.yaml`'s `packages:` list — the only key we
 * consume. Collects `- <glob>` items directly under `packages:` and stops at
 * the next top-level key (e.g. `allowBuilds:`), tolerating blank/comment lines.
 */
function pnpmPackages(yamlText: string): string[] {
  const globs: string[] = [];
  let inPackages = false;
  for (const line of yamlText.split(/\r?\n/)) {
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    if (!inPackages) {
      if (/^packages\s*:/.test(line)) inPackages = true;
      continue;
    }
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item) {
      globs.push(item[1].trim().replace(/^['"]|['"]$/g, ""));
      continue;
    }
    if (/^\S/.test(line)) break; // next top-level key → end of the packages list
  }
  return globs;
}
