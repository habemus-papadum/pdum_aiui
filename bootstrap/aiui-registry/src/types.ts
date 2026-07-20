/**
 * The shared shapes of the aiui channel registry: the on-disk entry (schema
 * v2), the enriched channel object every listing surface returns, and the
 * wire-protocol constant the native-messaging host stamps on every response.
 * These types ARE the cross-process protocol between independently-installed
 * aiui versions — see docs/proposals/aiui-registry.md.
 */

/**
 * Protocol version, stamped on every native-host response and every listing.
 * Versions the wire + on-disk formats (NOT this package's semver); bumps only
 * when those change. Consumers check a minimum and surface "update the aiui
 * native host" on mismatch instead of misbehaving.
 */
export const PROTOCOL = 2;

/** The current on-disk entry schema. Readers skip anything else. */
export const ENTRY_SCHEMA = 2;

/**
 * What kind of thing a registry entry advertises:
 * - `"channel"` — a real channel MCP server owned by a Claude Code session
 *   (its `ppid` is that session, joinable against `claude agents`).
 * - `"debug"` — a standalone debug server (`serve`): structurally unable to
 *   reach a session; selectors must mark it and never auto-pick it.
 * - `"remote"` — a local proxy to a channel on another machine; `pid` is the
 *   local tunnel-owner process, `port` the LOCAL proxy port.
 */
export type ChannelKind = "channel" | "debug" | "remote";

/** A single running server's advertised metadata, as stored on disk. */
export interface RegistryEntry {
  /** Entry schema version; readers recognise only {@link ENTRY_SCHEMA}. */
  schema: typeof ENTRY_SCHEMA;
  /** Stable identifier for this channel session (UUID or launcher-chosen). */
  tag: string;
  /** PID of the registering process (the server, or the tunnel owner). */
  pid: number;
  /**
   * PID of the parent process. For `kind: "channel"` this is the Claude Code
   * session that spawned the server over stdio — the join key for enrichment.
   */
  ppid: number;
  /**
   * TCP port of the channel's web backend. Always a LOCAL port — for
   * `kind: "remote"` it's the local end of the tunnel, so consumers dial
   * `127.0.0.1:<port>` regardless of kind.
   */
  port: number;
  /** Absolute working directory the server was launched in. */
  cwd: string;
  /**
   * ISO-8601 registration timestamp. Also feeds the recycled-pid liveness
   * cross-check: a pid whose OS start time is later than this is not us.
   */
  startedAt: string;
  kind: ChannelKind;
  /**
   * Display name given at registration (a debug server's `--name`, a remote
   * entry's `--name`). Real local channels usually have none — their name is
   * the live session name, joined at read time.
   */
  assignedName?: string;
  /**
   * The Chrome DevTools endpoint associated with this session, captured at
   * registration. Can drift if the browser restarts mid-session (documented
   * limitation); locally the profile's `DevToolsActivePort` stays the live
   * source of truth.
   */
  browserUrl?: string;
  /** `kind: "remote"` only: the remote hostname — display metadata, NOT addressing. */
  host?: string;
}

/** A registry entry paired with the file it was read from. */
export interface StoredEntry extends RegistryEntry {
  /** Absolute path to the `<pid>.json` registry file this entry came from. */
  file: string;
}

/** A running Claude Code session, as reported by `claude agents --json --all`. */
export interface ClaudeAgent {
  /** PID of the Claude Code process (matches a channel entry's `ppid`). */
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

/** The subset of live session info attached to an enriched channel. */
export interface SessionInfo {
  sessionId: string;
  name: string;
  status: string;
  kind: string;
  cwd: string;
  startedAt: number;
}

/** How the last `claude agents` fetch went. */
export type AgentsSourceStatus = "ok" | "claude-missing" | "error";

/**
 * The enrichment source's health, surfaced on EVERY listing so UIs fail loud:
 * a missing claude binary must show as a visible warning, never as a silent
 * fallback to unnamed channels (discovery itself does not fail because naming
 * did).
 */
export interface AgentsStatus {
  status: AgentsSourceStatus;
  /** The claude binary the fetch used (or found missing). */
  claudePath?: string;
  /** ISO-8601 time of the underlying fetch (may be served from cache). */
  fetchedAt?: string;
  /** Present when `status` is "error". */
  error?: string;
}

/**
 * The fully-enriched channel every listing surface returns — never a raw
 * entry. Entry fields stay top-level, the computed `resolvedName` joins them
 * (the one field every consumer displays), and the live join nests under
 * `session`.
 */
export interface EnrichedChannel extends StoredEntry {
  /** `assignedName` ?? live session name ?? host (remote) ?? `pid <ppid>`. */
  resolvedName: string;
  /** The owning Claude Code session, when the live join matched (`kind: "channel"` only). */
  session?: SessionInfo;
}

/** A complete listing response: what the native host and REST surfaces return. */
export interface ChannelListing {
  protocol: number;
  channels: EnrichedChannel[];
  agents: AgentsStatus;
}
