/**
 * Channel discovery for the panel — step 2's no-native-helper tier
 * (browser-extension-intent-tool.md §4): extension pages talk to loopback
 * freely, and one reachable channel enumerates all the others via its
 * registry mirror (`GET /debug/api/channels`). Seeds come from remembered
 * ports and manual entry; the native-messaging cold start arrives in step 3.
 *
 * Shapes mirror the channel server (`aiui-claude-channel`): `/health`
 * (web.ts) and `/debug/api/channels` (debug.ts). A `debug: true` channel is a
 * standalone `aiui serve` — structurally unable to reach a Claude session —
 * so the picker must mark it and never auto-pick it (registry.ts's rule).
 */

/** What `/health` answers (the fields the panel uses). */
export interface ChannelHealth {
  ok: boolean;
  pid: number;
  generation?: number;
  host?: string;
  /** Present iff the channel has the session bus — the capability gate. */
  session?: unknown;
  debug?: boolean;
}

/** One channel, as `/debug/api/channels` lists them (registry mirror). */
export interface ChannelEntry {
  tag?: string;
  port: number;
  pid?: number;
  cwd?: string;
  startedAt?: string;
  name?: string;
  debug?: boolean;
  self?: boolean;
}

const RECENT_KEY = "aiui.recentPorts";
const RECENT_MAX = 6;

/** The native-messaging host (`aiui extension install-native-host`). */
export const NATIVE_HOST_NAME = "com.habemus_papadum.aiui";

/**
 * Cold-start discovery via the native host: the registry on disk, no ports
 * needed. `undefined` means the host isn't installed/reachable — callers fall
 * back to port probing. One `sendNativeMessage` spawns one short-lived host.
 */
export async function nativeListChannels(): Promise<ChannelEntry[] | undefined> {
  try {
    const res = (await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, {
      cmd: "listChannels",
    })) as { ok?: boolean; channels?: ChannelEntry[]; error?: string };
    return res?.ok === true && Array.isArray(res.channels) ? res.channels : undefined;
  } catch {
    return undefined;
  }
}

/** Newest-first, deduped, capped. Pure. */
export function updateRecent(recent: number[], port: number, max = RECENT_MAX): number[] {
  return [port, ...recent.filter((p) => p !== port)].slice(0, max);
}

/** Short display label for a channel entry. Pure. */
export function channelLabel(entry: ChannelEntry): string {
  const base = entry.name ?? entry.cwd?.split("/").at(-1) ?? `pid ${entry.pid ?? "?"}`;
  return `${base} :${entry.port}${entry.debug === true ? " (debug — no session)" : ""}`;
}

export async function loadRecentPorts(): Promise<number[]> {
  const got = await chrome.storage.local.get(RECENT_KEY);
  const raw = got[RECENT_KEY];
  return Array.isArray(raw) ? raw.filter((p): p is number => Number.isInteger(p)) : [];
}

export async function saveRecentPort(port: number): Promise<void> {
  await chrome.storage.local.set({ [RECENT_KEY]: updateRecent(await loadRecentPorts(), port) });
}

/** Probe one port's `/health`; undefined when unreachable/not a channel. */
export async function probeHealth(
  port: number,
  timeoutMs = 1500,
): Promise<ChannelHealth | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      return undefined;
    }
    const body = (await res.json()) as ChannelHealth;
    return body !== null && typeof body === "object" && body.ok === true ? body : undefined;
  } catch {
    return undefined;
  }
}

/** The registry mirror, from one live channel. Empty on any failure. */
export async function listChannels(port: number): Promise<ChannelEntry[]> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/debug/api/channels`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) {
      return [];
    }
    const body = (await res.json()) as { channels?: ChannelEntry[] };
    return Array.isArray(body.channels) ? body.channels : [];
  } catch {
    return [];
  }
}

/**
 * Discover channels from seed ports: probe all seeds concurrently, then ask
 * the first live one for the full registry. Falls back to the live seeds
 * themselves (as anonymous entries) if none answers the registry route.
 */
export async function discoverChannels(seedPorts: number[]): Promise<ChannelEntry[]> {
  const seeds = [...new Set(seedPorts)];
  const alive = (
    await Promise.all(
      seeds.map(async (port) => ((await probeHealth(port)) !== undefined ? port : undefined)),
    )
  ).filter((p): p is number => p !== undefined);
  for (const port of alive) {
    const channels = await listChannels(port);
    if (channels.length > 0) {
      return channels;
    }
  }
  return alive.map((port) => ({ port }));
}
