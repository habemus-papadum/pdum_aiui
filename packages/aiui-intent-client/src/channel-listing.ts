/**
 * channel-listing.ts — the channel-listing DATA contract and its pure
 * formatting helpers, extracted from ui/channel-header.tsx (2026-08-03).
 *
 * Non-UI on purpose: `ext/channel.ts` (discovery — a module the extension's
 * node-ish tests reload per test via `vi.resetModules()`) consumes
 * `agentsWarning`, and importing it THROUGH the component file dragged
 * solid-js into that module graph — every reset re-instantiated Solid's dev
 * build and tripped its "multiple instances of Solid" warning, once per test,
 * in CI's logs. Formatting helpers live here; the component imports them like
 * everyone else.
 */

/** One channel, as the ENRICHED listings carry them (mirror route or native
 * host — both serve the registry package's enriched shape; only `port` is
 * load-bearing here, the rest is display). */
export interface ChannelEntry {
  port: number;
  tag?: string;
  cwd?: string;
  pid?: number;
  /** "channel" | "debug" | "remote" — a debug server carries no session. */
  kind?: string;
  /** Assigned name → live Claude session name → host → pid (listing-computed). */
  resolvedName?: string;
}

/** The enrichment source's health, as listings report it (loud, per design). */
export interface AgentsStatusLike {
  status: string;
  claudePath?: string;
  error?: string;
}

/** What the list seam answers: the channels, plus whether the extension's
 * native host failed to answer (absent on the page tier, which has no host),
 * plus a session-name degradation warning. The distinction picks the hint: an
 * empty list from a WORKING host means "nothing running" (`aiui claude`); a
 * host error means native messaging is broken and the remedy is
 * `aiui extension install-native-host`; an agents warning means channels work
 * but their live names don't (claude missing/broken). */
export interface ChannelListing {
  channels: ChannelEntry[];
  nativeHostError?: string;
  agentsWarning?: string;
}

/** The loud-but-partial message for a degraded agents join, or undefined. */
export const agentsWarning = (agents: AgentsStatusLike | undefined): string | undefined => {
  if (agents === undefined || agents.status === "ok") {
    return undefined;
  }
  return agents.status === "claude-missing"
    ? `Claude Code not found${agents.claudePath !== undefined ? ` at ${agents.claudePath}` : ""} — ` +
        "session names unavailable; re-run aiui to repair the native host"
    : `session names unavailable — \`claude agents\` failed${
        agents.error !== undefined ? ` (${agents.error})` : ""
      }`;
};

/** "name :port" — the resolved name (else the cwd tail) names the session. */
export const channelLabel = (entry: ChannelEntry): string => {
  const name = entry.resolvedName ?? entry.cwd?.split("/").filter(Boolean).at(-1) ?? "channel";
  return `${name} :${entry.port}${entry.kind === "debug" ? " (debug)" : ""}`;
};
