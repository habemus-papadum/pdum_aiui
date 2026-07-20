/**
 * Directory-affinity ranking for channel listings (ported from
 * aiui-claude-channel's list.ts, which retires onto this package in M4).
 */
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Rank of `target` relative to `base`:
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
 * Order servers by affinity to `base`: same directory first, then descendants
 * (shallowest first), then everything else — alphabetised by `cwd` within each
 * group, with a stable `pid` tiebreak. Returns a new array.
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
