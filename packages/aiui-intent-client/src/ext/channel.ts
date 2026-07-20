/**
 * channel.ts — finding the channel from an extension page.
 *
 * This is the tax the extension pays that the channel-served page does not. The
 * plain panel's origin IS the channel, so `resolveChannelPort()` reads its own
 * URL and discovery disappears (session.ts). A side panel lives at
 * `chrome-extension://…` and must go looking.
 *
 * The order, strongest evidence first:
 *   1. the CDP driver roster (`aiui2.cdpDriver:<port>` entries) — written
 *      INTO our storage by each channel itself, through this browser's own
 *      debug endpoint (src/cdp/tagger.ts). Only a channel actually driving
 *      THIS browser can plant one, so it is same-browser proof, not a guess
 *      — a live driver wins; with several (co-driving is supported) prefer
 *      the one carrying a real session;
 *   2. the port we used last (`chrome.storage.local`) — the common case, and it
 *      is verified before use, so a channel that has since died just falls
 *      through;
 *   3. the native host, if installed (`aiui extension install-native-host`) —
 *      it reads the on-disk registry, so a COLD start finds channels with no
 *      ports known at all;
 *   4. any live channel's registry mirror (`/debug/api/channels`) — one
 *      reachable channel enumerates the rest.
 *
 * Extension pages may fetch loopback freely (`host_permissions`), which is what
 * makes 1 and 3 possible at all. Storage keys are `aiui2.*`: the retired
 * frozen extension (out of the tree; still installed in some profiles) has its
 * own under its own extension id, and the two never meet.
 */

import { type AgentsStatusLike, agentsWarning } from "../ui/channel-header";
import { CDP_DRIVER_TAG_FRESH_MS, CDP_DRIVER_TAG_PREFIX } from "./manifest";

const RECENT_KEY = "aiui2.recentPorts";
const PINNED_KEY = "aiui2.pinnedPort";
const RECENT_MAX = 6;

/** The native-messaging host (`aiui extension install-native-host`). */
export const NATIVE_HOST_NAME = "com.habemus_papadum.aiui";

/** The minimum wire protocol this client understands (stamped on every host
 * response by the registry package). An older host gets a LOUD outdated
 * verdict instead of silently misbehaving. */
export const MIN_HOST_PROTOCOL = 2;

/** One channel, as the ENRICHED listings carry them (`/debug/api/channels`
 * and the native host serve the registry package's enriched shape). */
export interface ChannelEntry {
  port: number;
  cwd?: string;
  pid?: number;
  /** "channel" | "debug" | "remote". A `"debug"` server (standalone `aiui
   * serve`) has no Claude session behind it — structurally unable to carry a
   * turn, so never auto-picked. */
  kind?: string;
  /** Assigned name → live Claude session name → host → pid (listing-computed). */
  resolvedName?: string;
}

/** One CDP driver-roster entry, as a channel's tagger wrote it (same-browser
 * proof; `aiui2.cdpDriver:<port>`). Several may coexist — multi-agent
 * co-driving of one browser is a supported workflow. */
export interface CdpDriverTag {
  port: number;
  browserUrl: string;
  taggedAt: string;
}

/**
 * Read the driver roster: every fresh, well-formed entry, newest landing
 * first. Staleness-filtered here (CDP_DRIVER_TAG_FRESH_MS) so a crashed
 * channel's entry ages out; callers still liveness-probe before TRUSTING an
 * entry (a fresh entry only proves a recent write, not a live channel).
 */
export async function readCdpDrivers(): Promise<CdpDriverTag[]> {
  const all = (await chrome.storage.local.get(null)) as Record<string, unknown>;
  const now = Date.now();
  const drivers: CdpDriverTag[] = [];
  for (const [key, raw] of Object.entries(all)) {
    if (!key.startsWith(CDP_DRIVER_TAG_PREFIX)) {
      continue;
    }
    const tag = raw as Partial<CdpDriverTag>;
    if (
      !Number.isInteger(tag.port) ||
      typeof tag.browserUrl !== "string" ||
      typeof tag.taggedAt !== "string"
    ) {
      continue;
    }
    const at = Date.parse(tag.taggedAt);
    if (!Number.isFinite(at) || now - at > CDP_DRIVER_TAG_FRESH_MS) {
      continue; // stale — a crashed channel's leftover
    }
    drivers.push(tag as CdpDriverTag);
  }
  return drivers.sort((a, b) => Date.parse(b.taggedAt) - Date.parse(a.taggedAt));
}

/**
 * Watch the roster: taggers retry until the worker is awake, so entries land
 * (move, or vanish) AFTER a panel booted. Fires with the fresh roster on
 * every write under the prefix.
 */
export function onCdpDriversChanged(handler: (drivers: CdpDriverTag[]) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (
      area === "local" &&
      Object.keys(changes).some((key) => key.startsWith(CDP_DRIVER_TAG_PREFIX))
    ) {
      void readCdpDrivers().then(handler);
    }
  });
}

/** Newest-first, deduped, capped. Pure. */
export function updateRecent(recent: number[], port: number, max = RECENT_MAX): number[] {
  return [port, ...recent.filter((p) => p !== port)].slice(0, max);
}

/** Pick the channel to bind: a real session, newest registry entry first. Pure. */
export function pickChannel(entries: ChannelEntry[]): ChannelEntry | undefined {
  return entries.find((entry) => entry.kind !== "debug");
}

export async function loadRecentPorts(): Promise<number[]> {
  const got = await chrome.storage.local.get(RECENT_KEY);
  const raw = got[RECENT_KEY];
  return Array.isArray(raw) ? raw.filter((p): p is number => Number.isInteger(p)) : [];
}

export async function rememberPort(port: number): Promise<void> {
  await chrome.storage.local.set({ [RECENT_KEY]: updateRecent(await loadRecentPorts(), port) });
}

/** The user's explicit pick (the header switcher), if one is pinned. */
export async function loadPinnedPort(): Promise<number | undefined> {
  const got = await chrome.storage.local.get(PINNED_KEY);
  const raw = got[PINNED_KEY];
  return Number.isInteger(raw) ? (raw as number) : undefined;
}

/**
 * Pin an explicit pick: {@link discoverChannel} honors it above everything —
 * the CDP tag included — until it stops answering or the user picks again. In
 * this tier the channel need not drive the browser (content scripts do the
 * driving), so binding the wire to a debug channel is a legitimate choice the
 * auto-discovery ladder would otherwise override on every panel boot.
 */
export async function pinPort(port: number): Promise<void> {
  await chrome.storage.local.set({ [PINNED_KEY]: port });
  await rememberPort(port);
}

export async function clearPinnedPort(): Promise<void> {
  await chrome.storage.local.remove(PINNED_KEY);
}

/** Is a channel alive on this port? */
async function alive(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1200),
    });
    return res.ok && ((await res.json()) as { ok?: boolean }).ok === true;
  } catch {
    return false;
  }
}

/** The registry as one live channel mirrors it — the enriched listing plus
 * its loud agents status. */
export async function mirrorListingVia(
  port: number,
): Promise<{ channels: ChannelEntry[]; agents?: AgentsStatusLike }> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/debug/api/channels`, {
      signal: AbortSignal.timeout(1200),
    });
    if (!res.ok) {
      return { channels: [] };
    }
    const body = (await res.json()) as { channels?: ChannelEntry[]; agents?: AgentsStatusLike };
    return {
      channels: Array.isArray(body.channels) ? body.channels : [],
      ...(body.agents !== undefined ? { agents: body.agents } : {}),
    };
  } catch {
    return { channels: [] };
  }
}

/** The mirror's channel list alone. (Exported for the alignment supervisor's
 * driver labels — ext/align.ts.) */
export async function channelsVia(port: number): Promise<ChannelEntry[]> {
  return (await mirrorListingVia(port)).channels;
}

/** The native host's answer, with FAILURE kept distinct from "no channels":
 * an empty list from a working host means nothing is running (`aiui claude`
 * is the remedy); an error means native messaging itself is broken — not
 * installed, the host died, or it predates the current protocol — and the
 * remedy is re-running aiui / `aiui extension install-native-host`.
 * Conflating the two hid which hint to give (owner, 2026-07-19). */
export type NativeHostResult =
  | { ok: true; channels: ChannelEntry[]; agents?: AgentsStatusLike }
  | { ok: false; error: string };

/** The on-disk registry, via the native host — error kept, not swallowed. */
async function channelsViaNativeHost(): Promise<NativeHostResult> {
  try {
    const res = (await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, {
      cmd: "listChannels",
    })) as {
      ok?: boolean;
      protocol?: number;
      channels?: ChannelEntry[];
      agents?: AgentsStatusLike;
    };
    if (res?.ok !== true || !Array.isArray(res.channels)) {
      return { ok: false, error: "the host answered, but not with a channel list" };
    }
    const protocol = typeof res.protocol === "number" ? res.protocol : 1;
    if (protocol < MIN_HOST_PROTOCOL) {
      return {
        ok: false,
        error:
          `the installed native host is outdated (protocol ${protocol} < ${MIN_HOST_PROTOCOL}) — ` +
          "re-run aiui (or `aiui extension install-native-host`)",
      };
    }
    return {
      ok: true,
      channels: res.channels,
      ...(res.agents !== undefined ? { agents: res.agents } : {}),
    };
  } catch (err) {
    // Chrome's text names the cause: "Specified native messaging host not
    // found." (never installed) vs "Native host has exited." (it broke).
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Is native messaging itself working? (The boot-time diagnosis: one probe,
 * same `listChannels` command the discovery ladder uses.) */
export async function probeNativeHost(): Promise<NativeHostResult> {
  return channelsViaNativeHost();
}

/** What `listChannels` hands the chooser: the list, plus HOW it was obtained
 * — `nativeHostError` present means the list came from the mirror fallback
 * (or nowhere) because native messaging is broken — plus the loud
 * session-name degradation warning when the agents join is unhealthy. */
export interface ChannelListing {
  channels: ChannelEntry[];
  nativeHostError?: string;
  agentsWarning?: string;
}

/**
 * Every channel the registry knows — the chooser's list function, and THE one
 * place the extension uses native messaging: the native host reads the
 * on-disk registry (finds channels with zero live ports known); any live
 * channel's mirror is the fallback. Boot discovery below shares the same
 * helpers — native messaging stays confined to this module.
 */
export async function listChannels(currentPort?: number): Promise<ChannelListing> {
  const native = await channelsViaNativeHost();
  if (native.ok) {
    const warning = agentsWarning(native.agents);
    return {
      channels: native.channels,
      ...(warning !== undefined ? { agentsWarning: warning } : {}),
    };
  }
  const mirror = currentPort !== undefined ? await mirrorListingVia(currentPort) : { channels: [] };
  const warning = agentsWarning(mirror.agents);
  return {
    channels: mirror.channels,
    nativeHostError: native.error,
    ...(warning !== undefined ? { agentsWarning: warning } : {}),
  };
}

/** Find a channel to bind, or `undefined` (see the module doc for the order). */
export async function discoverChannel(): Promise<number | undefined> {
  // An explicit pick outranks the whole ladder: the user chose (the header
  // switcher), and reload must not un-choose for them. A pin that stopped
  // answering clears, and discovery resumes below.
  const pinned = await loadPinnedPort();
  if (pinned !== undefined) {
    if (await alive(pinned)) {
      return pinned;
    }
    await clearPinnedPort();
  }
  // The driver roster next: a channel that PROVED it drives this browser
  // beats any remembered or registry channel — those may belong to another
  // browser. Several channels may co-drive (supported): bind to a DRIVER,
  // preferring one that carries a real session over a debug server (the
  // roster itself is deliberately debug-blind; the registry keeps that
  // distinction, and the dropdown is where it surfaces to the user).
  const live: CdpDriverTag[] = [];
  for (const driver of await readCdpDrivers()) {
    if (await alive(driver.port)) {
      live.push(driver);
    }
  }
  const first = live[0];
  if (first !== undefined) {
    const mirror = await channelsVia(first.port);
    const isDebug = (p: number) => mirror.find((entry) => entry.port === p)?.kind === "debug";
    const chosen = live.find((driver) => !isDebug(driver.port)) ?? first;
    await rememberPort(chosen.port);
    return chosen.port;
  }
  for (const port of await loadRecentPorts()) {
    if (await alive(port)) {
      // Still up — but it may not be the newest session, so let it enumerate.
      const picked = pickChannel(await channelsVia(port));
      const chosen = picked?.port ?? port;
      await rememberPort(chosen);
      return chosen;
    }
  }
  const native = await channelsViaNativeHost();
  const picked = pickChannel(native.ok ? native.channels : []);
  if (picked !== undefined && (await alive(picked.port))) {
    await rememberPort(picked.port);
    return picked.port;
  }
  return undefined;
}
