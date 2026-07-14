/**
 * channel.ts — finding the channel from an extension page.
 *
 * This is the tax the extension pays that the channel-served page does not. The
 * plain panel's origin IS the channel, so `resolveChannelPort()` reads its own
 * URL and discovery disappears (session.ts). A side panel lives at
 * `chrome-extension://…` and must go looking.
 *
 * The order, strongest evidence first:
 *   1. the CDP tag (`aiui2.cdpChannel`) — written INTO our storage by the
 *      channel itself, through this browser's own debug endpoint
 *      (src/cdp/tagger.ts). Only the channel actually driving THIS browser
 *      can plant it, so it is same-browser proof, not a guess — it wins
 *      whenever the tagged channel is alive;
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
 * makes 1 and 3 possible at all. Storage keys are `aiui2.*`: the frozen client
 * has its own, under its own extension id, and the two never meet.
 */

import { CDP_CHANNEL_TAG_KEY } from "./manifest";

const RECENT_KEY = "aiui2.recentPorts";
const RECENT_MAX = 6;

/** The native-messaging host (`aiui extension install-native-host`). */
export const NATIVE_HOST_NAME = "com.habemus_papadum.aiui";

/** One channel, as `/debug/api/channels` lists them (the registry mirror). */
export interface ChannelEntry {
  port: number;
  name?: string;
  cwd?: string;
  pid?: number;
  /** A standalone `aiui serve`: reachable, but with no Claude session behind
   * it — structurally unable to carry a turn, so never auto-picked. */
  debug?: boolean;
}

/** The channel's CDP tag, as the tagger wrote it (same-browser proof). */
export interface CdpChannelTag {
  port: number;
  browserUrl: string;
  taggedAt: string;
}

/** Read the CDP tag, if a channel has tagged this browser. */
export async function readCdpTag(): Promise<CdpChannelTag | undefined> {
  const got = await chrome.storage.local.get(CDP_CHANNEL_TAG_KEY);
  const raw = got[CDP_CHANNEL_TAG_KEY] as Partial<CdpChannelTag> | undefined;
  return raw !== undefined && Number.isInteger(raw.port) && typeof raw.browserUrl === "string"
    ? (raw as CdpChannelTag)
    : undefined;
}

/**
 * Watch the tag: the tagger retries until the worker is awake, so it may land
 * (or move) AFTER a panel booted. Fires with the fresh tag on every write.
 */
export function onCdpTagChanged(handler: (tag: CdpChannelTag | undefined) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && CDP_CHANNEL_TAG_KEY in changes) {
      void readCdpTag().then(handler);
    }
  });
}

/** Newest-first, deduped, capped. Pure. */
export function updateRecent(recent: number[], port: number, max = RECENT_MAX): number[] {
  return [port, ...recent.filter((p) => p !== port)].slice(0, max);
}

/** Pick the channel to bind: a real session, newest registry entry first. Pure. */
export function pickChannel(entries: ChannelEntry[]): ChannelEntry | undefined {
  return entries.find((entry) => entry.debug !== true);
}

export async function loadRecentPorts(): Promise<number[]> {
  const got = await chrome.storage.local.get(RECENT_KEY);
  const raw = got[RECENT_KEY];
  return Array.isArray(raw) ? raw.filter((p): p is number => Number.isInteger(p)) : [];
}

export async function rememberPort(port: number): Promise<void> {
  await chrome.storage.local.set({ [RECENT_KEY]: updateRecent(await loadRecentPorts(), port) });
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

/** The registry, as one live channel mirrors it. */
async function channelsVia(port: number): Promise<ChannelEntry[]> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/debug/api/channels`, {
      signal: AbortSignal.timeout(1200),
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

/** The on-disk registry, via the native host. `undefined` = not installed. */
async function channelsViaNativeHost(): Promise<ChannelEntry[] | undefined> {
  try {
    const res = (await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, {
      cmd: "listChannels",
    })) as { ok?: boolean; channels?: ChannelEntry[] };
    return res?.ok === true && Array.isArray(res.channels) ? res.channels : undefined;
  } catch {
    return undefined; // no host installed — port probing carries us
  }
}

/**
 * Every channel the registry knows — the chooser's list function, and THE one
 * place the extension uses native messaging: the native host reads the
 * on-disk registry (finds channels with zero live ports known); any live
 * channel's mirror is the fallback. Boot discovery below shares the same
 * helpers — native messaging stays confined to this module.
 */
export async function listChannels(currentPort?: number): Promise<ChannelEntry[]> {
  const native = await channelsViaNativeHost();
  if (native !== undefined) {
    return native;
  }
  return currentPort !== undefined ? await channelsVia(currentPort) : [];
}

/** Find a channel to bind, or `undefined` (see the module doc for the order). */
export async function discoverChannel(): Promise<number | undefined> {
  // The CDP tag first: the channel that PROVED it drives this browser beats
  // any remembered or registry channel — those may belong to another browser.
  const tag = await readCdpTag();
  if (tag !== undefined && (await alive(tag.port))) {
    await rememberPort(tag.port);
    return tag.port;
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
  const picked = pickChannel(native ?? []);
  if (picked !== undefined && (await alive(picked.port))) {
    await rememberPort(picked.port);
    return picked.port;
  }
  return undefined;
}
