/**
 * Discover and rank the aiui channel MCP servers currently running.
 *
 * The one public entry point is {@link listMcpServers}; {@link dirRank} and
 * {@link sortServers} are the pure ranking primitives it's built from (exported
 * so the ordering rules can be tested without touching the filesystem).
 */
// TODO(aiui-registry): collapses onto @habemus-papadum/aiui-registry's enriched
// listChannels in M4 (docs/proposals/aiui-registry.md §4).
import { readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  isProcessAlive,
  type RunningServer,
  readEntry,
  registryDir,
  removeEntryFile,
} from "./registry";

export interface ListOptions {
  /**
   * Delete registry files whose process is no longer alive — a server that was
   * hard-killed before it could clean up after itself. Defaults to `true`.
   * Pruning is best-effort and race-safe (see {@link removeEntryFile}).
   */
  prune?: boolean;
}

/**
 * Rank of `target` relative to `base`, used to group servers by directory
 * affinity:
 * - `0` — same directory.
 * - `n > 0` — `target` is `n` levels below `base` (base is an ancestor).
 * - `Infinity` — `target` is not inside `base` at all.
 */
export function dirRank(base: string, target: string): number {
  const rel = relative(resolve(base), resolve(target));
  if (rel === "") {
    return 0;
  }
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return Number.POSITIVE_INFINITY;
  }
  return rel.split(sep).length;
}

/**
 * Order servers by affinity to `base`:
 * 1. same directory first,
 * 2. then descendants, shallowest first (by ancestor depth),
 * 3. then everything else,
 *
 * with entries alphabetised by `cwd` within each group and a stable `pid`
 * tiebreak for entries that share a directory. Returns a new array; the input
 * is left untouched.
 */
export function sortServers<T extends { cwd: string; pid: number }>(
  base: string,
  servers: T[],
): T[] {
  return [...servers].sort((a, b) => {
    const ra = dirRank(base, a.cwd);
    const rb = dirRank(base, b.cwd);
    if (ra !== rb) {
      return ra === Number.POSITIVE_INFINITY ? 1 : rb === Number.POSITIVE_INFINITY ? -1 : ra - rb;
    }
    if (a.cwd !== b.cwd) {
      return a.cwd < b.cwd ? -1 : 1;
    }
    return a.pid - b.pid;
  });
}

/**
 * List the channel MCP servers currently running, ranked by directory affinity
 * to `dir` (defaults to the current working directory).
 *
 * Only servers whose process is still alive are returned; stale registry files
 * are pruned by default (see {@link ListOptions.prune}). Malformed or half-
 * written files are skipped without being deleted — they may belong to a live
 * server still writing itself in.
 */
export function listMcpServers(
  dir: string = process.cwd(),
  options: ListOptions = {},
): RunningServer[] {
  const { prune = true } = options;
  const regDir = registryDir({ create: false });

  let names: string[];
  try {
    names = readdirSync(regDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const running: RunningServer[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) {
      continue;
    }
    const file = join(regDir, name);
    const entry = readEntry(file);
    if (!entry) {
      continue;
    }
    if (isProcessAlive(entry.pid)) {
      running.push({ ...entry, file });
    } else if (prune) {
      try {
        removeEntryFile(file);
      } catch {
        // Best-effort: a failed prune must not break listing.
      }
    }
  }

  return sortServers(dir, running);
}
