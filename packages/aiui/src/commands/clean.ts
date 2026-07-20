/**
 * `aiui clean` — reset aiui's on-disk state for a clean-slate demo.
 *
 * aiui keeps all of its state in two cache roots — never in `node_modules`, so a
 * plain reinstall of the package leaves everything below behind:
 *
 *   <repo>/.aiui-cache/     traces, recordings, the session-browser profile(s),
 *                           and the project-level config.json (see projectCacheDir)
 *   <user cache>/           ~/.cache/aiui — the user config.json (incl. the
 *                           persisted first-run answers: channel.bind, enterNudge),
 *                           the running-server registry (mcp/), remote-tunnel
 *                           browser-profiles/, and the ~150-160 MB managed
 *                           browser installs (chromium/, chrome/)
 *
 * `clean` removes both so the next `aiui claude` behaves like a fresh install:
 * the first-run prompts return, the managed-browser offer returns,
 * and traces + browser logins are gone. Re-showing that download is the whole
 * reason the browser is in scope by default — `--keep-browser` spares the
 * re-download when you only want to reset the cheap state. Because it deletes
 * hundreds of MB and login state, it confirms first (skip with `--yes`) and
 * `--dry-run` prints the plan without touching anything.
 */
import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { listMcpServers, projectCacheDir } from "@habemus-papadum/aiui-claude-channel/internal";
import { cacheDir } from "@habemus-papadum/aiui-util";
import chalk from "chalk";
import { allManagedCacheDirs } from "../util/managed-browser";
import { choose } from "../util/prompt";
import { printError, printNote, printWarning } from "../util/ui";

export interface CleanOptions {
  /** Limit the reset to this repo's `.aiui-cache/`. */
  projectOnly?: boolean;
  /** Limit the reset to the user cache (`~/.cache/aiui`). */
  userOnly?: boolean;
  /** Keep the managed browser installs (skip the ~150-160 MB re-download). */
  keepBrowser?: boolean;
  /** Print what would be deleted, then stop. */
  dryRun?: boolean;
  /** Delete without the confirmation prompt. */
  yes?: boolean;
}

/** The three cache roots `clean` reasons about (resolved, never created). */
export interface CleanRoots {
  /** `<base>/.aiui-cache`. */
  project: string;
  /** `~/.cache/aiui` (respects `$AIUI_CACHE` / `$XDG_CACHE_HOME`). */
  user: string;
  /** The managed-browser dirs (chromium/, chrome/) — children of {@link CleanRoots.user}. */
  browsers: string[];
}

/** One thing `clean` will delete: a root path, optionally sparing some children. */
export interface CleanTarget {
  /** Short human label for the plan output. */
  label: string;
  /** The directory to remove. */
  path: string;
  /**
   * Absolute child paths to preserve instead of deleting `path` wholesale. Used
   * by `--keep-browser` to clear the user cache while keeping the managed
   * browser dirs (`chromium/`, `chrome/`).
   */
  keep?: string[];
}

/** Resolve the cache roots for a given base dir (defaults to cwd). */
export function cleanRoots(base: string = process.cwd()): CleanRoots {
  return {
    project: projectCacheDir(base),
    user: cacheDir(undefined, { create: false }),
    browsers: allManagedCacheDirs(false),
  };
}

/**
 * Decide which roots to remove from the flags. Pure over `roots`: the fs is only
 * touched later, when the targets are resolved to concrete deletions.
 */
export function planCleanTargets(opts: CleanOptions, roots: CleanRoots): CleanTarget[] {
  const targets: CleanTarget[] = [];
  if (!opts.userOnly) {
    targets.push({ label: "project cache", path: roots.project });
  }
  if (!opts.projectOnly) {
    targets.push(
      opts.keepBrowser
        ? {
            label: "user cache (keeping the managed browsers)",
            path: roots.user,
            keep: roots.browsers,
          }
        : { label: "user cache", path: roots.user },
    );
  }
  return targets;
}

/**
 * The concrete absolute paths a target will delete. `[path]` for a plain target,
 * or its children minus the kept ones for a `--keep-browser` target; `[]` when
 * nothing there exists (so an already-clean root drops out of the plan).
 */
export function resolveDeletions(target: CleanTarget): string[] {
  if (!existsSync(target.path)) {
    return [];
  }
  if (!target.keep?.length) {
    return [target.path];
  }
  const keep = new Set(target.keep.map((p) => resolve(p)));
  let children: string[];
  try {
    children = readdirSync(target.path);
  } catch {
    return [];
  }
  return children.map((c) => resolve(join(target.path, c))).filter((p) => !keep.has(p));
}

export async function runClean(opts: CleanOptions = {}): Promise<void> {
  if (opts.projectOnly && opts.userOnly) {
    printError(
      "pass at most one of --project-only / --user-only",
      "with neither, `aiui clean` removes both",
    );
    process.exitCode = 1;
    return;
  }

  const cwd = process.cwd();
  const targets = planCleanTargets(opts, cleanRoots(cwd));
  const planned = targets
    .map((target) => ({ target, paths: resolveDeletions(target) }))
    .filter((p) => p.paths.length > 0);

  if (planned.length === 0) {
    console.log("nothing to clean — no aiui state here or in the user cache.");
    return;
  }

  // Show the plan (size per target, then the consequences).
  let total = 0;
  console.log("aiui clean will remove:\n");
  for (const { target, paths } of planned) {
    const size = paths.reduce((n, p) => n + pathSize(p), 0);
    total += size;
    console.log(`  ${formatBytes(size).padStart(9)}  ${target.label}`);
    console.log(`  ${" ".repeat(9)}  ${chalk.dim(target.path)}`);
  }
  console.log(`\n  ${formatBytes(total).padStart(9)}  total\n`);

  const clearingUser = !opts.projectOnly;
  const removingBrowser = clearingUser && !opts.keepBrowser;
  const consequences = [
    "traces and session-browser logins are cleared",
    clearingUser &&
      "the one-time first-run prompts (channel bind, enter-nudge) return on next launch",
    removingBrowser && "the managed browser re-downloads (~150-160 MB) on the next `aiui claude`",
  ].filter((line): line is string => Boolean(line));
  console.log("This resets aiui toward a fresh install:");
  for (const line of consequences) {
    console.log(`  • ${line}`);
  }
  console.log("");

  const running = listMcpServers(cwd);
  if (running.length) {
    printWarning(
      `${running.length} aiui session${running.length === 1 ? "" : "s"} still running`,
      "stop them first — a live session re-plants cache artifacts (registry entry, native-host wrapper) as it runs, and an open browser can lock files being deleted",
    );
  }

  if (opts.dryRun) {
    printNote("dry run — nothing was deleted");
    return;
  }

  if (!opts.yes) {
    if (!process.stdin.isTTY) {
      printError(
        "refusing to delete without confirmation",
        "re-run with --yes for a non-interactive clean, or from a terminal",
      );
      process.exitCode = 1;
      return;
    }
    const answer = await choose(
      "Delete these now?",
      [
        { key: "y", label: "yes, delete" },
        { key: "n", label: "no, cancel" },
      ],
      "n",
    );
    if (answer !== "y") {
      console.log("cancelled — nothing was deleted.");
      return;
    }
  }

  let freed = 0;
  let failed = 0;
  for (const { paths } of planned) {
    for (const p of paths) {
      const size = pathSize(p);
      try {
        rmSync(p, { recursive: true, force: true });
        freed += size;
      } catch (error) {
        failed++;
        printWarning(
          `could not remove ${p}`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  if (failed) {
    printWarning(
      `${failed} path${failed === 1 ? "" : "s"} could not be deleted`,
      "a running browser can lock its files — close the session browser and re-run",
    );
  }
  console.log(`clean complete — freed ~${formatBytes(freed)}.`);
}

/** Recursive on-disk size of a path, best-effort. Symlinks count as their own entry, never followed. */
function pathSize(p: string): number {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(p);
  } catch {
    return 0;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    return st.size;
  }
  let entries: string[];
  try {
    entries = readdirSync(p);
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    total += pathSize(join(p, entry));
  }
  return total;
}

/** Human-readable byte count (binary units), e.g. `346.0 MB`. */
export function formatBytes(n: number): string {
  if (n < 1024) {
    return `${n} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}
