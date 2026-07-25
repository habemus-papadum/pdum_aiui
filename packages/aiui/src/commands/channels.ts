/**
 * `aiui channels list` — print this machine's channel registry.
 *
 *   aiui channels list           one block per channel, every stored value
 *   aiui channels list --json    the ChannelListing wire shape, machine-readable
 *
 * The only *reading* surface the CLI has on the registry: `aiui dashboard` and
 * `aiui mcp quick` pick a channel to act on, and the selectors they share show
 * one line each. This prints everything an entry carries — tag/pid/port/cwd,
 * the launch timestamps, the browser endpoint, the file it came from, and the
 * live `claude agents` join — for when a surface says "no channel" and you
 * need to know what is actually on disk.
 *
 * It goes through the registry package's enriched listing (the ONE read path
 * the native host, `/debug/api/channels`, and VS Code also use), so what it
 * prints is exactly what those surfaces see: dead and recycled-pid entries are
 * already gone, names are resolved, and the `claude agents` health rides along
 * — reported loudly, because unnamed channels must never look like a quiet
 * fallback.
 *
 * That listing carries the LEFT side of the session join — each channel with
 * the Claude Code session that owns it. This command also prints the right
 * side: the sessions `claude agents` reports that NO channel entry claims,
 * read from the same 4 s cache the listing just filled (so it costs no extra
 * `claude` spawn). Without them "no channel here" and "no session here" look
 * identical, and they call for opposite fixes.
 */

import { resolve } from "node:path";
import {
  type AgentsStatus,
  type ChannelListing,
  type ClaudeAgent,
  cachedAgents,
  type EnrichedChannel,
  listChannels,
  registryDir,
  sortServers,
} from "@habemus-papadum/aiui-registry";
import chalk from "chalk";
import { glyph, theme } from "../util/ui";

export interface ChannelsListOptions {
  /**
   * Print the {@link ChannelListing} — the `/debug/api/channels` wire shape,
   * plus a `sessionsWithoutChannel` array — instead of the formatted blocks.
   */
  json?: boolean;
  /**
   * Delete registry files whose process is dead or recycled (commander's
   * `--no-prune` clears it). Pruning never changes what is *listed* — dead
   * entries are filtered either way — only whether their files are cleaned up.
   */
  prune?: boolean;
}

/** Inputs the pure formatter needs from the environment. */
export interface FormatOptions {
  /** Ranking base — the channel launched here is marked "this directory". */
  baseDir: string;
  /** `Date.now()`, injected so the relative ages are testable. */
  nowMs: number;
  /** The directory the entries were read from, for the header. */
  registryDir: string;
  /** Live sessions no channel claims ({@link sessionsWithoutChannel}). */
  sessions?: ClaudeAgent[];
}

/** Column width for the key gutter — wide enough for "started". */
const KEY_WIDTH = 9;

export function runChannelsList(opts: ChannelsListOptions = {}): void {
  const baseDir = process.cwd();
  const listing = listChannels({
    client: "cli",
    baseDir,
    prune: opts.prune ?? true,
  });
  // The same client name, so this hits the cache `listChannels` just wrote
  // (4 s TTL) instead of spawning `claude agents` a second time.
  const sessions = sessionsWithoutChannel(listing, cachedAgents({ client: "cli" }).agents, baseDir);

  if (opts.json) {
    console.log(JSON.stringify({ ...listing, sessionsWithoutChannel: sessions }, null, 2));
    return;
  }

  for (const line of formatListing(listing, {
    baseDir,
    nowMs: Date.now(),
    registryDir: registryDir({ create: false }),
    sessions,
  })) {
    console.log(line);
  }
}

/**
 * The right side of the join: live Claude Code sessions no channel entry
 * claims — a session started as plain `claude`, or one whose channel died
 * under it. Ranked by the same directory affinity as the channels.
 *
 * Claimed means *joined*, not merely "some entry has this ppid": only
 * `kind: "channel"` entries join a session, so a debug/remote entry whose ppid
 * happens to be a live session's pid must not swallow it.
 */
export function sessionsWithoutChannel(
  listing: ChannelListing,
  agents: ClaudeAgent[],
  baseDir: string,
): ClaudeAgent[] {
  const claimed = new Set(listing.channels.filter((c) => c.session).map((c) => c.ppid));
  return sortServers(
    baseDir,
    agents.filter((agent) => !claimed.has(agent.pid)),
  );
}

/** Render a whole listing: the header, the agents status, then one block each. */
export function formatListing(listing: ChannelListing, opts: FormatOptions): string[] {
  const count = listing.channels.length;
  const lines = [
    `${theme.accent(glyph.note)} ${count === 0 ? "no channels" : `${count} channel${count === 1 ? "" : "s"}`} ${theme.muted(
      `· protocol ${listing.protocol} · ${opts.registryDir}`,
    )}`,
    formatAgents(listing.agents),
  ];
  if (count === 0) {
    lines.push(theme.muted("  nothing registered — start one with `aiui claude`."));
  }
  for (const channel of listing.channels) {
    lines.push("", ...formatChannel(channel, opts));
  }
  lines.push(...formatSessions(opts.sessions ?? [], opts));
  return lines;
}

/**
 * The unclaimed sessions, compactly — they are context for the channels above,
 * not entries in their own right, so one line plus a cwd each.
 */
function formatSessions(sessions: ClaudeAgent[], opts: FormatOptions): string[] {
  if (sessions.length === 0) {
    return [];
  }
  const lines = [
    "",
    `${theme.muted(glyph.note)} ${theme.muted(
      `${sessions.length} Claude Code session${sessions.length === 1 ? "" : "s"} with no channel — not launched by \`aiui claude\``,
    )}`,
  ];
  for (const session of sessions) {
    lines.push(
      `  ${chalk.bold(session.name)}  ${theme.muted(
        `${session.status} · ${session.kind} · pid ${session.pid} · ${ago(session.startedAt, opts.nowMs)}`,
      )}`,
      `    ${theme.muted(session.cwd)}`,
    );
  }
  return lines;
}

/**
 * The enrichment source's health. A missing `claude` binary is a warning, not
 * a footnote: discovery still works, but every name degrades to `pid N`, and a
 * reader who doesn't know that will think the registry is broken.
 */
function formatAgents(agents: AgentsStatus): string {
  const claude = agents.claudePath ?? "claude";
  if (agents.status === "ok") {
    const fetched = agents.fetchedAt ? ` · fetched ${agents.fetchedAt}` : "";
    return `  ${theme.muted(`session names: ${claude}${fetched}`)}`;
  }
  const why =
    agents.status === "claude-missing"
      ? `\`claude\` not found (${claude}) — names fall back to \`pid N\``
      : `\`claude agents\` failed: ${agents.error ?? "unknown error"}`;
  return `  ${theme.caution(`${glyph.warn} session names unavailable — ${why}`)}`;
}

/** One channel's block: the header line, then every value the entry carries. */
export function formatChannel(channel: EnrichedChannel, opts: FormatOptions): string[] {
  const marks: string[] = [channel.kind];
  if (channel.session) {
    marks.push(channel.session.status);
  }
  if (resolve(channel.cwd) === resolve(opts.baseDir)) {
    marks.push("this directory");
  }

  const lines = [
    `${theme.accent(glyph.caret)} ${chalk.bold(channel.resolvedName)}  ${theme.muted(marks.join(" · "))}`,
    row("tag", channel.tag),
    row("pid", `${channel.pid} ${theme.muted(`(parent ${channel.ppid})`)}`),
    row("port", `${channel.port} ${theme.muted(`→ http://127.0.0.1:${channel.port}/`)}`),
    row("cwd", channel.cwd),
    row(
      "started",
      `${channel.startedAt} ${theme.muted(`(${ago(channel.startedAt, opts.nowMs)})`)}`,
    ),
  ];
  if (channel.assignedName !== undefined) {
    lines.push(row("assigned", channel.assignedName));
  }
  if (channel.host !== undefined) {
    lines.push(row("host", channel.host));
  }
  if (channel.browserUrl !== undefined) {
    lines.push(row("browser", channel.browserUrl));
  }
  lines.push(row("entry", `${channel.file} ${theme.muted(`(schema ${channel.schema})`)}`));

  const { session } = channel;
  if (session) {
    lines.push(
      row("session", `${session.name} ${theme.muted(`· ${session.status} · ${session.kind}`)}`),
      sub("id", session.sessionId),
      sub(
        "started",
        `${iso(session.startedAt)} ${theme.muted(`(${ago(session.startedAt, opts.nowMs)})`)}`,
      ),
      sub("cwd", session.cwd),
    );
  } else if (channel.kind === "channel") {
    // Only real channels join — a debug/remote entry having no session is
    // structural, not a symptom. Here it IS a symptom: the owning session went
    // away, or `claude agents` didn't report it.
    lines.push(row("session", theme.caution(`no live session for pid ${channel.ppid}`)));
  }
  return lines;
}

/** A `key   value` row under a channel header. */
function row(key: string, value: string): string {
  return `  ${theme.muted(key.padEnd(KEY_WIDTH))} ${value}`;
}

/** A row nested under `session`, aligned past the key gutter. */
function sub(key: string, value: string): string {
  return `  ${" ".repeat(KEY_WIDTH)} ${theme.muted(key.padEnd(KEY_WIDTH - 1))} ${value}`;
}

/** ISO-8601 for an epoch-ms timestamp (the shape `claude agents` reports). */
function iso(epochMs: number): string {
  return Number.isFinite(epochMs) ? new Date(epochMs).toISOString() : String(epochMs);
}

/**
 * Coarse relative age — "3h 12m ago". Accepts either timestamp shape the
 * registry carries (entries store ISO-8601, sessions epoch ms) and passes
 * anything unparseable through as-is rather than printing "NaN ago".
 */
export function ago(started: string | number, nowMs: number): string {
  const startedMs = typeof started === "number" ? started : Date.parse(started);
  if (!Number.isFinite(startedMs)) {
    return "unknown age";
  }
  const seconds = Math.max(0, Math.round((nowMs - startedMs) / 1000));
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ${minutes % 60}m ago`;
  }
  return `${Math.floor(hours / 24)}d ${hours % 24}h ago`;
}
