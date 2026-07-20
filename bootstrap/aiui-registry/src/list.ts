/**
 * The enriched channel listing — the ONE read path every consumer surface
 * (native host, `/debug/api/channels`, VS Code, CLI selectors) goes through,
 * so a renamed session shows up everywhere or nowhere. Composes: scan →
 * validate → liveness (with recycled-pid pruning) → cached `claude agents`
 * join → name resolution → directory-affinity ranking.
 */
import type { AgentsFetchResult } from "./agents.ts";
import { AGENTS_TTL_MS, cachedAgents, MAX_LOCK_AGE_MS } from "./cache.ts";
import { type GetStartTimes, livenessVerdicts } from "./liveness.ts";
import { registryDir } from "./paths.ts";
import { sortServers } from "./rank.ts";
import { scanEntries } from "./read.ts";
import {
  type ChannelListing,
  type ClaudeAgent,
  type EnrichedChannel,
  PROTOCOL,
  type RegistryEntry,
  type SessionInfo,
} from "./types.ts";
import { removeEntryFile } from "./write.ts";

export interface ListChannelsOptions {
  /** Client-class name for the agents-cache lock (e.g. "native-host"). */
  client: string;
  /** Ranking base for directory affinity. Defaults to `process.cwd()`. */
  baseDir?: string;
  /** Claude binary override (the wrapper-baked `AIUI_CLAUDE_BIN`). */
  claudePath?: string;
  /** Delete entries whose process is dead or recycled. Defaults to `true`. */
  prune?: boolean;
  /** Overrides for tests. */
  registryDir?: string;
  agentsDir?: string;
  ttlMs?: number;
  maxLockAgeMs?: number;
  now?: () => number;
  fetch?: (claudePath?: string) => AgentsFetchResult;
  getStartTimes?: GetStartTimes;
}

/**
 * The naming triple's resolution (docs/proposals/aiui-registry.md §3):
 * assigned name (stored) → live session name (joined) → host (remote) →
 * `pid <ppid>` (what the selectors historically showed).
 */
export function resolveName(entry: RegistryEntry, session?: SessionInfo): string {
  if (entry.assignedName) {
    return entry.assignedName;
  }
  if (session?.name) {
    return session.name;
  }
  if (entry.kind === "remote" && entry.host) {
    return entry.host;
  }
  return `pid ${entry.ppid}`;
}

function sessionFor(
  entry: RegistryEntry,
  byPid: Map<number, ClaudeAgent>,
): SessionInfo | undefined {
  // Only real channels join: their ppid IS the owning Claude Code session. A
  // debug/remote entry's ppid is whatever shell launched it — a join there
  // could attach an unrelated session that happens to hold that pid.
  if (entry.kind !== "channel") {
    return undefined;
  }
  const agent = byPid.get(entry.ppid);
  if (!agent) {
    return undefined;
  }
  return {
    sessionId: agent.sessionId,
    name: agent.name,
    status: agent.status,
    kind: agent.kind,
    cwd: agent.cwd,
    startedAt: agent.startedAt,
  };
}

/** List the live channels, fully enriched, ranked by affinity to `baseDir`. */
export function listChannels(options: ListChannelsOptions): ChannelListing {
  const dir = options.registryDir ?? registryDir({ create: false });
  const nowMs = (options.now ?? Date.now)();
  const prune = options.prune ?? true;

  const entries = scanEntries(dir);
  const verdicts = livenessVerdicts(entries, {
    nowMs,
    ...(options.getStartTimes ? { getStartTimes: options.getStartTimes } : {}),
  });
  const live = entries.filter((entry) => {
    if (verdicts.get(entry.pid) === "live") {
      return true;
    }
    if (prune) {
      try {
        removeEntryFile(entry.file);
      } catch {
        // Best-effort: a failed prune must not break listing.
      }
    }
    return false;
  });

  const { agents, info } = cachedAgents({
    client: options.client,
    ...(options.agentsDir !== undefined ? { dir: options.agentsDir } : {}),
    ...(options.claudePath !== undefined ? { claudePath: options.claudePath } : {}),
    ttlMs: options.ttlMs ?? AGENTS_TTL_MS,
    maxLockAgeMs: options.maxLockAgeMs ?? MAX_LOCK_AGE_MS,
    now: () => nowMs,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const byPid = new Map(agents.map((a) => [a.pid, a]));

  const channels: EnrichedChannel[] = live.map((entry) => {
    const session = sessionFor(entry, byPid);
    return {
      ...entry,
      resolvedName: resolveName(entry, session),
      ...(session ? { session } : {}),
    };
  });

  return {
    protocol: PROTOCOL,
    channels: sortServers(options.baseDir ?? process.cwd(), channels),
    agents: info,
  };
}
