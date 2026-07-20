/**
 * Liveness: is the process behind a registry entry still the process that
 * wrote it? Two checks (docs/proposals/aiui-registry.md §2):
 *
 *  1. `kill(pid, 0)` — cheap existence probe (`EPERM` still means "alive").
 *  2. Start-time cross-check — the recycled-pid fix. The real server started
 *     *before* its registration was written, so the OS start time of the pid's
 *     current holder must satisfy `osStart ≤ startedAt + slack`. A holder that
 *     started after `startedAt` is an unrelated process that inherited the
 *     pid → the entry is stale.
 *
 * Start times come from `/proc/<pid>/stat` on Linux and one batched
 * `ps -o etime=` spawn elsewhere. An unavailable start time fails OPEN (the
 * entry stays live) — never prune a possibly-live server on a probe error.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Slack between an entry's `startedAt` and the OS start time (clock granularity). */
export const START_TIME_SLACK_MS = 5000;

/** Linux USER_HZ — the unit of `/proc/<pid>/stat`'s starttime. Fixed at 100 on
 * every mainstream kernel/arch (the syscall ABI constant, independent of the
 * kernel's internal HZ). */
const LINUX_CLOCK_TICKS = 100;

/**
 * Is a process with this PID currently alive? `process.kill(pid, 0)` sends no
 * signal but performs the existence/permission check: `ESRCH` means gone,
 * `EPERM` means alive-but-not-ours (still alive).
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Parse a `ps -o etime=` value (`[[dd-]hh:]mm:ss`) into seconds. */
export function parseEtimeSeconds(etime: string): number | undefined {
  const m = etime.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) {
    return undefined;
  }
  const [, dd, hh, mm, ss] = m;
  return ((Number(dd ?? 0) * 24 + Number(hh ?? 0)) * 60 + Number(mm)) * 60 + Number(ss);
}

/** Parse `ps -o pid=,etime=` output into a pid → epoch-ms start-time map. */
export function parsePsStartTimes(raw: string, nowMs: number): Map<number, number> {
  const out = new Map<number, number>();
  for (const line of raw.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\S+)$/);
    if (!m) {
      continue;
    }
    const elapsed = parseEtimeSeconds(m[2]);
    if (elapsed !== undefined) {
      out.set(Number(m[1]), nowMs - elapsed * 1000);
    }
  }
  return out;
}

/** One batched `ps` spawn for all pids. `ps` exits non-zero when any pid is
 * gone but still prints the ones it found — recover its stdout from the error. */
function psStartTimes(pids: number[], nowMs: number): Map<number, number> {
  let raw: string;
  try {
    raw = execFileSync("ps", ["-p", pids.join(","), "-o", "pid=,etime="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    });
  } catch (err) {
    const stdout = (err as { stdout?: unknown }).stdout;
    raw = typeof stdout === "string" ? stdout : "";
  }
  return parsePsStartTimes(raw, nowMs);
}

/** Parse one `/proc/<pid>/stat` body: field 22 (starttime, in USER_HZ ticks
 * since boot), reading past the parenthesised comm which may contain spaces. */
export function parseProcStatStartTicks(stat: string): number | undefined {
  const close = stat.lastIndexOf(")");
  if (close === -1) {
    return undefined;
  }
  // After ") " the next token is field 3; starttime is field 22 → index 19.
  const ticks = Number(stat.slice(close + 2).split(" ")[19]);
  return Number.isFinite(ticks) ? ticks : undefined;
}

function procStartTimes(pids: number[]): Map<number, number> {
  const out = new Map<number, number>();
  let btimeMs: number | undefined;
  try {
    const m = readFileSync("/proc/stat", "utf8").match(/^btime\s+(\d+)/m);
    btimeMs = m ? Number(m[1]) * 1000 : undefined;
  } catch {
    btimeMs = undefined;
  }
  if (btimeMs === undefined) {
    return out;
  }
  for (const pid of pids) {
    try {
      const ticks = parseProcStatStartTicks(readFileSync(`/proc/${pid}/stat`, "utf8"));
      if (ticks !== undefined) {
        out.set(pid, btimeMs + (ticks / LINUX_CLOCK_TICKS) * 1000);
      }
    } catch {
      // Process vanished between the alive probe and here — leave unset (fails open).
    }
  }
  return out;
}

/** Injectable start-time source (tests). */
export type GetStartTimes = (pids: number[], nowMs: number) => Map<number, number>;

/** OS start times (epoch ms) for `pids`; absent = could not determine. */
export function processStartTimes(
  pids: number[],
  nowMs: number,
  platform: NodeJS.Platform = process.platform,
): Map<number, number> {
  if (pids.length === 0) {
    return new Map();
  }
  return platform === "linux" ? procStartTimes(pids) : psStartTimes(pids, nowMs);
}

export type LivenessVerdict = "live" | "dead" | "recycled";

/**
 * Judge each entry: `dead` (no such process), `recycled` (the pid's current
 * holder started after the entry was written — an unrelated process), or
 * `live`. Both non-live verdicts mean "prune the file".
 */
export function livenessVerdicts(
  entries: Array<{ pid: number; startedAt: string }>,
  options: { nowMs?: number; getStartTimes?: GetStartTimes } = {},
): Map<number, LivenessVerdict> {
  const nowMs = options.nowMs ?? Date.now();
  const verdicts = new Map<number, LivenessVerdict>();
  const survivors: number[] = [];
  for (const entry of entries) {
    if (isProcessAlive(entry.pid)) {
      survivors.push(entry.pid);
    } else {
      verdicts.set(entry.pid, "dead");
    }
  }
  const starts = (options.getStartTimes ?? processStartTimes)(survivors, nowMs);
  for (const entry of entries) {
    if (verdicts.has(entry.pid)) {
      continue;
    }
    const osStart = starts.get(entry.pid);
    const registeredAt = Date.parse(entry.startedAt);
    const recycled =
      osStart !== undefined &&
      Number.isFinite(registeredAt) &&
      osStart > registeredAt + START_TIME_SLACK_MS;
    verdicts.set(entry.pid, recycled ? "recycled" : "live");
  }
  return verdicts;
}
