/**
 * The `claude agents --json --all` bridge — the source of live session names.
 * Failure is LOUD but partial (docs/proposals/aiui-registry.md §4): a missing
 * binary yields `status: "claude-missing"` (with the path that was tried),
 * never a silent empty list, so UIs can tell the user instead of degrading
 * quietly. Callers still get their channel listing either way.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { AgentsSourceStatus, ClaudeAgent } from "./types.ts";

/** The default binary name, resolved from PATH (works everywhere EXCEPT the
 * native-messaging context, where Chrome's minimal env has no user PATH — the
 * wrapper script bakes an absolute `AIUI_CLAUDE_BIN` instead). */
export const DEFAULT_CLAUDE = "claude";

/** How one fetch went. */
export interface AgentsFetchResult {
  status: AgentsSourceStatus;
  agents: ClaudeAgent[];
  claudePath: string;
  error?: string;
}

/**
 * Parse `claude agents --json` output. Returns only well-formed agent objects,
 * and `[]` for anything unparseable — a malformed payload is "no sessions
 * visible", not an error (the error channel is for the SPAWN failing).
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

/** Injectable spawner (tests). Throws like `execFileSync` on failure. */
export type RunAgents = (claudePath: string) => string;

function runAgentsExec(claudePath: string): string {
  return execFileSync(claudePath, ["agents", "--json", "--all"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000,
  });
}

/** Run `claude agents --json --all` and classify the outcome. */
export function fetchAgents(
  claudePath: string = DEFAULT_CLAUDE,
  run: RunAgents = runAgentsExec,
): AgentsFetchResult {
  // An explicit absolute path (the wrapper-baked AIUI_CLAUDE_BIN) that isn't
  // there gets the precise verdict without a spawn attempt.
  if (isAbsolute(claudePath) && !existsSync(claudePath)) {
    return { status: "claude-missing", agents: [], claudePath };
  }
  try {
    return { status: "ok", agents: parseClaudeAgents(run(claudePath)), claudePath };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { status: "claude-missing", agents: [], claudePath };
    }
    return {
      status: "error",
      agents: [],
      claudePath,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
