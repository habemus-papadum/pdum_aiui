/**
 * Bridge to `claude agents --json` — the running Claude Code sessions.
 *
 * A channel server's parent process *is* the Claude Code session that spawned
 * it, so a registry entry's `ppid` matches a Claude agent's `pid`. That lets us
 * label a server with its session's human name (e.g. "pdum-aiui-97") and id
 * instead of a bare pid, both in the selector and in the `list_channels` tool.
 */
import { execFileSync } from "node:child_process";
import type { RegistryEntry } from "./registry";

/** A running Claude Code session, as reported by `claude agents --json --all`. */
export interface ClaudeAgent {
  /** PID of the Claude Code process (matches a channel server's `ppid`). */
  pid: number;
  /** Working directory of the session. */
  cwd: string;
  /** e.g. "interactive". */
  kind: string;
  /** Epoch milliseconds. */
  startedAt: number;
  /** The session UUID. */
  sessionId: string;
  /** The session's human-readable name (e.g. "pdum-aiui-97"). */
  name: string;
  /** e.g. "idle" | "busy". */
  status: string;
}

/** The subset of session info attached to a server when we can match it. */
export interface SessionInfo {
  sessionId: string;
  name: string;
  status: string;
  kind: string;
  cwd: string;
  startedAt: number;
}

/** A registry entry enriched with the Claude Code session that owns it. */
export interface EnrichedServer extends RegistryEntry {
  session?: SessionInfo;
}

/**
 * Parse the JSON emitted by `claude agents --json`. Returns only well-formed
 * agent objects, and `[]` for anything unparseable — callers treat missing
 * session info as "unknown", never as an error.
 */
export function parseClaudeAgents(raw: string): ClaudeAgent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const agents: ClaudeAgent[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const a = item as Record<string, unknown>;
    if (
      typeof a.pid === "number" &&
      typeof a.cwd === "string" &&
      typeof a.kind === "string" &&
      typeof a.startedAt === "number" &&
      typeof a.sessionId === "string" &&
      typeof a.name === "string" &&
      typeof a.status === "string"
    ) {
      agents.push({
        pid: a.pid,
        cwd: a.cwd,
        kind: a.kind,
        startedAt: a.startedAt,
        sessionId: a.sessionId,
        name: a.name,
        status: a.status,
      });
    }
  }
  return agents;
}

/**
 * List the running Claude Code sessions via `claude agents --json --all`.
 *
 * Best-effort: any failure (claude not on PATH, an unexpected flag, a non-zero
 * exit) yields `[]` so callers degrade to showing pids rather than blowing up.
 */
export function listClaudeAgents(): ClaudeAgent[] {
  try {
    const raw = execFileSync("claude", ["agents", "--json", "--all"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    return parseClaudeAgents(raw);
  } catch {
    return [];
  }
}

/** Index agents by pid for quick `ppid` lookups. */
export function agentsByPid(agents: ClaudeAgent[]): Map<number, ClaudeAgent> {
  return new Map(agents.map((a) => [a.pid, a]));
}

/**
 * Attach each server's owning Claude session (matched by `server.ppid ===
 * agent.pid`). Servers with no matching agent are returned with no `session`.
 */
export function enrichServers(servers: RegistryEntry[], agents: ClaudeAgent[]): EnrichedServer[] {
  const byPid = agentsByPid(agents);
  return servers.map((server) => {
    const agent = byPid.get(server.ppid);
    if (!agent) {
      return { ...server };
    }
    return {
      ...server,
      session: {
        sessionId: agent.sessionId,
        name: agent.name,
        status: agent.status,
        kind: agent.kind,
        cwd: agent.cwd,
        startedAt: agent.startedAt,
      },
    };
  });
}
