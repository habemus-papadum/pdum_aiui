/**
 * Claude Code session names for the picker — a minimal async mirror of
 * aiui-claude-channel's agents.ts (the source of truth for the `claude agents
 * --json --all` contract).
 *
 * A channel server's `ppid` is the Claude Code session that spawned it, so
 * matching a channel's `ppid` against an agent's `pid` names the channel the
 * way the CLI selector does ("pdum-aiui-97" instead of a pid). Best-effort by
 * design: `claude` missing from the extension host's PATH, a timeout, or junk
 * output all yield an empty map — the picker then falls back to tags.
 */
import { execFile } from "node:child_process";

/** Parse `claude agents --json` output into a pid → session-name map. */
export function parseAgentNames(raw: string): Map<number, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Map();
  }
  if (!Array.isArray(parsed)) {
    return new Map();
  }
  const names = new Map<number, string>();
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const a = item as Record<string, unknown>;
    if (typeof a.pid === "number" && typeof a.name === "string") {
      names.set(a.pid, a.name);
    }
  }
  return names;
}

/**
 * The running Claude Code sessions, as pid → name. Resolves `new Map()` on any
 * failure — never rejects, never blocks the picker for more than `timeoutMs`.
 */
export function claudeSessionNames(timeoutMs = 3000): Promise<Map<number, string>> {
  return new Promise((resolve) => {
    execFile(
      "claude",
      ["agents", "--json", "--all"],
      { encoding: "utf8", timeout: timeoutMs },
      (error, stdout) => {
        resolve(error ? new Map() : parseAgentNames(stdout));
      },
    );
  });
}
