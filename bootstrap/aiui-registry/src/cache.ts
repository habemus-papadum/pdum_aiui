/**
 * The shared agents cache: one cache file, many readers/writers across
 * processes (docs/proposals/aiui-registry.md §4).
 *
 * Correctness comes from ATOMIC RENAME, not locks: any writer's fresh result
 * is equally valid, so last-writer-wins is correct by construction. What the
 * per-client lock files buy is only SPAWN DEDUP — at most one concurrent
 * `claude agents` subprocess per client class ("native-host", "vscode",
 * "channel", …). A stale lock (max age 30 s, then broken) can therefore delay
 * one class's refresh; it can never block a read or corrupt the cache. Do not
 * "fix" this into a global mutex.
 */
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentsFetchResult, fetchAgents, parseClaudeAgents } from "./agents.ts";
import { agentsDir } from "./paths.ts";
import type { AgentsSourceStatus, AgentsStatus, ClaudeAgent } from "./types.ts";
import { writeFileAtomic } from "./write.ts";

/** How long a fetch stays fresh — long enough that a cold native-messaging
 * host usually finds a warm cache, short enough that a rename shows promptly. */
export const AGENTS_TTL_MS = 4000;

/** A lock older than this is presumed abandoned and broken. */
export const MAX_LOCK_AGE_MS = 30_000;

const CACHE_FILE = "cache.json";
const CACHE_SCHEMA = 1;

/** The on-disk cache shape (its own schema, versioned separately from entries). */
interface AgentsCacheFile {
  schema: typeof CACHE_SCHEMA;
  fetchedAt: string;
  status: AgentsSourceStatus;
  claudePath?: string;
  error?: string;
  agents: ClaudeAgent[];
}

/** What {@link cachedAgents} returns: the agents plus the loud status. */
export interface CachedAgents {
  agents: ClaudeAgent[];
  info: AgentsStatus;
}

export interface CachedAgentsOptions {
  /** Client-class name — becomes the lock filename (`<client>.lock`). */
  client: string;
  /** Directory for cache + locks. Defaults to {@link agentsDir}. */
  dir?: string;
  /** Claude binary (absolute `AIUI_CLAUDE_BIN` or PATH-resolved default). */
  claudePath?: string;
  ttlMs?: number;
  maxLockAgeMs?: number;
  /** Clock override (tests). */
  now?: () => number;
  /** Fetch override (tests). */
  fetch?: (claudePath?: string) => AgentsFetchResult;
}

const CLIENT_RE = /^[a-z][a-z0-9-]*$/;

function readCacheFile(file: string): AgentsCacheFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const c = parsed as Record<string, unknown>;
  if (
    c.schema !== CACHE_SCHEMA ||
    typeof c.fetchedAt !== "string" ||
    typeof c.status !== "string" ||
    !Array.isArray(c.agents)
  ) {
    return null;
  }
  return {
    schema: CACHE_SCHEMA,
    fetchedAt: c.fetchedAt,
    status: c.status as AgentsSourceStatus,
    ...(typeof c.claudePath === "string" ? { claudePath: c.claudePath } : {}),
    ...(typeof c.error === "string" ? { error: c.error } : {}),
    // Re-validate through the tolerant parser so a hand-edited cache can't
    // smuggle malformed agents into consumers.
    agents: parseClaudeAgents(JSON.stringify(c.agents)),
  };
}

/** Try to take `lockFile`; break it first when older than `maxAgeMs`. */
function tryAcquireLock(lockFile: string, maxAgeMs: number, nowMs: number): boolean {
  const attempt = (): boolean => {
    try {
      writeFileSync(lockFile, `${process.pid} ${new Date(nowMs).toISOString()}\n`, { flag: "wx" });
      return true;
    } catch {
      return false;
    }
  };
  if (attempt()) {
    return true;
  }
  try {
    if (nowMs - statSync(lockFile).mtimeMs > maxAgeMs) {
      unlinkSync(lockFile);
      return attempt();
    }
  } catch {
    // Lock vanished (owner finished) or stat failed — one more try either way.
    return attempt();
  }
  return false;
}

function releaseLock(lockFile: string): void {
  try {
    unlinkSync(lockFile);
  } catch {
    // Already broken by someone who judged us stale — fine.
  }
}

function toResult(cache: AgentsCacheFile): CachedAgents {
  return {
    agents: cache.agents,
    info: {
      status: cache.status,
      fetchedAt: cache.fetchedAt,
      ...(cache.claudePath !== undefined ? { claudePath: cache.claudePath } : {}),
      ...(cache.error !== undefined ? { error: cache.error } : {}),
    },
  };
}

/**
 * The agents list, through the shared cache: fresh cache → serve it; stale →
 * refresh under this client's lock; lock held elsewhere → serve the stale copy
 * (stale-while-revalidate). Cold start with a held lock fetches anyway — dedup
 * is best-effort, correctness never depends on it.
 */
export function cachedAgents(options: CachedAgentsOptions): CachedAgents {
  if (!CLIENT_RE.test(options.client)) {
    throw new Error(`cachedAgents: invalid client name ${JSON.stringify(options.client)}`);
  }
  const dir = options.dir ?? agentsDir();
  mkdirSync(dir, { recursive: true });
  const nowMs = (options.now ?? Date.now)();
  const ttlMs = options.ttlMs ?? AGENTS_TTL_MS;
  const cacheFile = join(dir, CACHE_FILE);

  const cached = readCacheFile(cacheFile);
  if (cached && nowMs - Date.parse(cached.fetchedAt) < ttlMs) {
    return toResult(cached);
  }

  const lockFile = join(dir, `${options.client}.lock`);
  const acquired = tryAcquireLock(lockFile, options.maxLockAgeMs ?? MAX_LOCK_AGE_MS, nowMs);
  if (!acquired && cached) {
    return toResult(cached);
  }
  try {
    const fetched = (options.fetch ?? fetchAgents)(options.claudePath);
    const next: AgentsCacheFile = {
      schema: CACHE_SCHEMA,
      fetchedAt: new Date(nowMs).toISOString(),
      status: fetched.status,
      claudePath: fetched.claudePath,
      ...(fetched.error !== undefined ? { error: fetched.error } : {}),
      agents: fetched.agents,
    };
    writeFileAtomic(cacheFile, `${JSON.stringify(next, null, 2)}\n`);
    return toResult(next);
  } finally {
    if (acquired) {
      releaseLock(lockFile);
    }
  }
}
