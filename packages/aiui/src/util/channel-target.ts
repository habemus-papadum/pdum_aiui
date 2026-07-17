/**
 * channel-target.ts — resolve which running channel a channel-CONNECTING
 * command should talk to.
 *
 * Used by the commands that genuinely reach into a channel: `aiui debug` (the
 * trace viewer, bound to one channel's port) and, in spirit, the intent
 * client's standalone `pnpm dev` launcher. Deliberately NOT used by `aiui
 * vite` any more: an app it serves reaches the channel through the intent
 * client at `/intent/`, not a build-time port, so there is nothing to resolve.
 * (This helper lived in `commands/vite.ts` while vite was that connection;
 * it moved here when vite stopped connecting — owner, 2026-07-17.)
 */

import type { RunningServer } from "@habemus-papadum/aiui-claude-channel";

/** The channel a command should point at, or why it couldn't be resolved. */
export interface ChannelTarget {
  /** The server resolved without prompting (by tag). */
  server?: RunningServer;
  /** Servers to offer in the interactive selector (no tag given, ≥1 running). */
  select?: RunningServer[];
  /** A human-readable reason a requested server couldn't be resolved. */
  error?: string;
}

/**
 * Decide which running channel server a command should connect to.
 *
 * Pure so it can be unit-tested without spawning anything:
 *  - With a `targetTag`, return the server whose `tag` matches exactly; if none
 *    matches, return an `error` naming the tag and the tags that *are* running.
 *  - Without a `targetTag`, don't guess: return `{}` when nothing is running, or
 *    `{ select }` so the caller runs the same selector as `quick` (which
 *    auto-picks a lone server and prompts when there are several).
 */
export function resolveChannelTarget(
  servers: RunningServer[],
  targetTag: string | undefined,
): ChannelTarget {
  if (targetTag !== undefined) {
    const server = servers.find((s) => s.tag === targetTag);
    if (!server) {
      const running = servers.length > 0 ? servers.map((s) => s.tag).join(", ") : "(none running)";
      return {
        error: `no running aiui channel with tag "${targetTag}" — running tags: ${running}`,
      };
    }
    return { server };
  }
  return servers.length > 0 ? { select: servers } : {};
}
