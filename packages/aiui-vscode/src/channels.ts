/**
 * Discovery of, and the HTTP client for, running aiui channel servers.
 *
 * Discovery is `@habemus-papadum/aiui-registry`'s ENRICHED listing (the
 * npm-pinned package that single-sources the registry protocol): entries
 * arrive with the live Claude session joined and a `resolvedName` computed,
 * through the shared 4 s agents cache — no private `claude agents` mirror in
 * this extension any more. Reading here is deliberately NON-destructive
 * (`prune: false`): an editor extension only looks; the channel's own tools
 * own the pruning.
 *
 * The client half speaks the channel web backend's session HTTP surface
 * (web.ts): `GET /session/peers` to list the browser views of a session, and
 * `POST /session/publish` to hand one of them a contribution.
 */
import { sep } from "node:path";
import {
  type EnrichedChannel,
  isProcessAlive,
  listChannels as listRegistryChannels,
  registryDir,
} from "@habemus-papadum/aiui-registry";
import type { SelectionContribution } from "./contribution";
import { SESSION_CONTRIBUTION_TOPIC } from "./contribution";

export { isProcessAlive, registryDir };

/** One running channel server — the registry package's enriched shape. */
export type ChannelEntry = EnrichedChannel;

/** A connected session view, as reported by `GET /session/peers`. */
export interface SessionPeer {
  clientId: string;
  /** What kind of view: `app`, `code`, `git`, … (`app` tabs ingest selections). */
  role?: string;
  /** Short human label (the page title). */
  label?: string;
  /** The view's live `location.href`. */
  url?: string;
  /** Browser-tab correlation hints (opaque here). */
  tab?: Record<string, unknown>;
}

/** `GET /session/peers` response. */
export interface PeersResponse {
  ok: boolean;
  peers: SessionPeer[];
  /** The session's cached `armed` slot (informational). */
  armed: boolean;
}

/** `POST /session/publish` outcome, success or nack. */
export interface PublishResult {
  ok: boolean;
  /** On success: the views the message was actually sent to. */
  delivered?: SessionPeer[];
  /** The session's cached `armed` slot at send time (informational). */
  armed?: boolean;
  /** On a nack: why nothing was delivered. */
  error?: string;
}

export interface ListChannelsOptions {
  /** Registry directory override (tests). */
  dir?: string;
  /** Agents-cache dir override (tests — avoids a real `claude` spawn). */
  agentsDir?: string;
  /**
   * When set, channels launched in (an ancestor of) this directory sort first —
   * the channel for *this* workspace is almost always the one meant.
   */
  workspaceDir?: string;
}

/** How strongly a channel's launch dir binds it to the workspace. */
function affinity(cwd: string, workspaceDir: string | undefined): number {
  if (!workspaceDir) {
    return 0;
  }
  if (cwd === workspaceDir) {
    return 2;
  }
  return workspaceDir.startsWith(cwd.endsWith(sep) ? cwd : cwd + sep) ? 1 : 0;
}

/**
 * The currently running channel servers, ENRICHED — workspace-affine first,
 * real sessions before debug servers, then newest first.
 */
export function listChannels(options: ListChannelsOptions = {}): ChannelEntry[] {
  const channels = listRegistryChannels({
    client: "vscode",
    // Non-destructive on purpose — see the module doc.
    prune: false,
    ...(options.dir !== undefined ? { registryDir: options.dir } : {}),
    ...(options.agentsDir !== undefined ? { agentsDir: options.agentsDir } : {}),
    ...(options.workspaceDir !== undefined ? { baseDir: options.workspaceDir } : {}),
  }).channels;
  return channels.sort(
    (a, b) =>
      affinity(b.cwd, options.workspaceDir) - affinity(a.cwd, options.workspaceDir) ||
      Number(a.kind === "debug") - Number(b.kind === "debug") ||
      b.startedAt.localeCompare(a.startedAt),
  );
}

/** How a picker titles a channel: its resolved name, marked if debug. */
export function channelLabel(channel: ChannelEntry): string {
  return `${channel.resolvedName}${channel.kind === "debug" ? " · debug" : ""}`;
}

/** List a channel's connected session views. Throws on an unreachable server. */
export async function fetchPeers(port: number, timeoutMs = 2000): Promise<PeersResponse> {
  const res = await fetch(`http://127.0.0.1:${port}/session/peers`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`GET /session/peers responded ${res.status}`);
  }
  return (await res.json()) as PeersResponse;
}

/**
 * Send a selection to one of a channel's views over `POST /session/publish`.
 * Resolves with the server's ack or nack (a nack is a result, not a throw);
 * throws only when the server itself is unreachable.
 */
export async function publishSelection(
  port: number,
  clientId: string,
  contribution: SelectionContribution,
  timeoutMs = 4000,
): Promise<PublishResult> {
  const res = await fetch(`http://127.0.0.1:${port}/session/publish`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId, topic: SESSION_CONTRIBUTION_TOPIC, payload: contribution }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = (await res.json().catch(() => undefined)) as PublishResult | undefined;
  if (body && typeof body.ok === "boolean") {
    return body;
  }
  return { ok: false, error: `POST /session/publish responded ${res.status}` };
}
