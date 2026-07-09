/**
 * Discovery of, and the HTTP client for, running aiui channel servers.
 *
 * Discovery reads the same on-disk registry the channel writes: one
 * `<pid>.json` per live `aiui-claude-channel mcp` process under
 * `cacheDir("mcp")` (aiui-claude-channel's registry.ts is the source of truth
 * for the entry shape — mirrored here so the extension doesn't drag the whole
 * channel package into its bundle). Reading is strictly non-destructive:
 * entries whose process is gone are skipped, never pruned — the channel's own
 * tools own the pruning.
 *
 * The client half speaks the channel web backend's session HTTP surface
 * (web.ts): `GET /session/peers` to list the browser views of a session, and
 * `POST /session/publish` to hand one of them a contribution.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { cacheDir } from "@habemus-papadum/aiui-util";
import type { SelectionContribution } from "./contribution";
import { SESSION_CONTRIBUTION_TOPIC } from "./contribution";

/** One running channel server, as advertised in its registry file. */
export interface ChannelEntry {
  /** Stable session identifier (a UUID, or launcher-chosen). */
  tag: string;
  /** PID of the channel server process. */
  pid: number;
  /** PID of the Claude Code session that spawned it. */
  ppid: number;
  /** Loopback TCP port of the server's web backend. */
  port: number;
  /** Absolute directory the server was launched in. */
  cwd: string;
  /** ISO-8601 start timestamp. */
  startedAt: string;
  /** Display name the server chose for itself (a debug server's `--name`). */
  name?: string;
  /**
   * A standalone debug server (`aiui-claude-channel serve`, e.g. the
   * a standalone `serve`): fully usable as a selection target, but marked in the
   * picker and sorted after real sessions.
   */
  debug?: boolean;
}

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

/** The registry directory (not created if missing — that means nothing runs). */
export function registryDir(): string {
  return cacheDir("mcp", { create: false });
}

/** Loose-validate one registry file; `null` for anything malformed. */
function readEntry(file: string): ChannelEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const e = parsed as Record<string, unknown>;
  if (
    typeof e.tag !== "string" ||
    typeof e.pid !== "number" ||
    typeof e.ppid !== "number" ||
    typeof e.port !== "number" ||
    typeof e.cwd !== "string" ||
    typeof e.startedAt !== "string"
  ) {
    return null;
  }
  return {
    tag: e.tag,
    pid: e.pid,
    ppid: e.ppid,
    port: e.port,
    cwd: e.cwd,
    startedAt: e.startedAt,
    ...(typeof e.name === "string" ? { name: e.name } : {}),
    ...(e.debug === true ? { debug: true } : {}),
  };
}

/** Is a process with this PID alive? (`EPERM` still means "alive".) */
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
  const dir = options.dir ?? registryDir();
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
