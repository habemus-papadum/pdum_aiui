/**
 * Discovery of, and the HTTP client for, running aiui channel servers.
 *
 * Discovery reads the same on-disk registry the channel writes: one
 * `<pid>.json` per live `aiui-claude-channel mcp` process under
 * `cacheDir("mcp")`. The registry read side — the {@link ChannelEntry} shape,
 * {@link readEntry} validator, {@link isProcessAlive} probe, and
 * {@link registryDir} — is single-sourced in `@habemus-papadum/aiui-util`, a
 * prod dependency this extension already bundles, so importing it adds nothing
 * new to the VSIX. Reading is strictly non-destructive: entries whose process
 * is gone are skipped, never pruned — the channel's own tools own the pruning.
 *
 * The client half speaks the channel web backend's session HTTP surface
 * (web.ts): `GET /session/peers` to list the browser views of a session, and
 * `POST /session/publish` to hand one of them a contribution.
 */
import { readdirSync } from "node:fs";
import { join, sep } from "node:path";
import {
  isProcessAlive,
  type RegistryEntry,
  readEntry,
  registryDir,
} from "@habemus-papadum/aiui-util";
import type { SelectionContribution } from "./contribution";
import { SESSION_CONTRIBUTION_TOPIC } from "./contribution";

export { isProcessAlive, registryDir };

/** One running channel server, as advertised in its registry file. */
export type ChannelEntry = RegistryEntry;

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
  /** Registry directory override (tests). Defaults to {@link registryDir}. */
  dir?: string;
  /** Liveness probe override (tests). Defaults to {@link isProcessAlive}. */
  isAlive?: (pid: number) => boolean;
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
 * The currently running channel servers: every registry entry whose process is
 * still alive — workspace-affine first, real sessions before debug servers,
 * then newest first.
 */
export function listChannels(options: ListChannelsOptions = {}): ChannelEntry[] {
  const dir = options.dir ?? registryDir({ create: false });
  const isAlive = options.isAlive ?? isProcessAlive;
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return []; // no registry directory → nothing is running
  }
  const entries = files
    .map((f) => readEntry(join(dir, f)))
    .filter((e): e is ChannelEntry => e !== null && isAlive(e.pid));
  return entries.sort(
    (a, b) =>
      affinity(b.cwd, options.workspaceDir) - affinity(a.cwd, options.workspaceDir) ||
      Number(a.debug === true) - Number(b.debug === true) ||
      b.startedAt.localeCompare(a.startedAt),
  );
}

/** How a picker titles a channel: its own name, else its tag, marked if debug. */
export function channelLabel(channel: ChannelEntry): string {
  return `${channel.name ?? channel.tag}${channel.debug === true ? " · debug" : ""}`;
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
