/**
 * tagger.ts — the channel TAGS the extension over CDP (owner, 2026-07-15).
 *
 * The problem it solves: the extension may be running in one Chrome while the
 * channel's CDP endpoint points at a completely different one, and nothing
 * makes that visible. No `chrome.*` API tells an extension its own browser's
 * debug port — but the binding can be PUSHED from the other side: the channel
 * attaches to the extension's service-worker target *through its own CDP
 * endpoint* and writes a tag into `chrome.storage.local`. Only the browser
 * actually behind that endpoint can receive the write, so the tag is
 * SELF-VERIFYING: an extension that finds a fresh `aiui2.cdpDriver:<port>`
 * entry KNOWS this browser is one that channel drives — discovery and
 * same-browser proof in one fact. Entries form a ROSTER (one per channel,
 * each tagger writing only its own): multiple agents co-driving one browser
 * is a SUPPORTED workflow, and the roster is what makes it visible
 * (src/cdp-align.ts). The single-slot tag this replaced flapped
 * last-writer-wins under two channels. (It also beats native messaging for cold-start discovery in
 * the session browser: a fresh install with zero remembered ports finds its
 * channel from the tag.)
 *
 * Lifecycle: an idle MV3 worker has no CDP target, so the tagger RETRIES on
 * a short beat until it lands, then keeps watching — a worker restart or a
 * different browser appearing behind the endpoint re-tags. Best-effort by
 * design: no browser, no extension, no problem — it just keeps trying
 * quietly (one log line per state change).
 */

import { CDP_DRIVER_TAG_PREFIX, EXTENSION_ID } from "../ext/manifest";
import { type CdpConnection, type CdpSocket, connectCdp } from "./protocol";

export { CDP_DRIVER_TAG_PREFIX };

/** What the write puts under `aiui2.cdpDriver:<port>` — one ROSTER entry.
 * Each channel writes only its own (multi-agent co-driving is supported;
 * the single-slot tag this replaced flapped under two channels). */
export interface CdpChannelTag {
  /** The channel's port — what the extension should dial. */
  port: number;
  /** The CDP endpoint the tag traveled through (the proof's provenance). */
  browserUrl: string;
  taggedAt: string;
}

export interface TaggerOptions {
  /** The channel's own port — what the tag tells the extension to dial. */
  channelPort: () => number | undefined;
  /** The CDP endpoint to tag through (the proxy's discovery — launch info,
   * then the profile's DevToolsActivePort, then AIUI_USER_DATA_DIR). */
  endpoint: () => Promise<string | undefined>;
  log?: (message: string) => void;
  /** Retry beat, ms (tests shorten it). */
  intervalMs?: number;
  socketFactory?: (url: string) => CdpSocket;
}

/** http://host:port → ws browser endpoint via /json/version. */
async function browserWsUrl(httpUrl: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${httpUrl.replace(/\/$/, "")}/json/version`, {
      signal: AbortSignal.timeout(2000),
    });
    const body = (await res.json()) as { webSocketDebuggerUrl?: string };
    return body.webSocketDebuggerUrl;
  } catch {
    return undefined;
  }
}

/**
 * One tagging attempt: find the extension's service worker among the
 * endpoint's targets, attach, write the tag, detach. Returns whether it
 * landed (false = no browser / no extension / worker asleep — retry later).
 */
export async function tagOnce(
  browserUrl: string,
  channelPort: number,
  socketFactory?: (url: string) => CdpSocket,
): Promise<boolean> {
  const wsUrl = await browserWsUrl(browserUrl);
  if (wsUrl === undefined) {
    return false;
  }
  let cdp: CdpConnection | undefined;
  try {
    cdp = await connectCdp(wsUrl, socketFactory);
    const targets = (await cdp.send("Target.getTargets")) as {
      targetInfos?: Array<{ targetId: string; type: string; url: string }>;
    };
    const worker = targets.targetInfos?.find(
      (t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${EXTENSION_ID}/`),
    );
    if (worker === undefined) {
      return false; // extension absent or its worker is asleep — retry
    }
    const attached = (await cdp.send("Target.attachToTarget", {
      targetId: worker.targetId,
      flatten: true,
    })) as { sessionId?: string };
    if (attached.sessionId === undefined) {
      return false;
    }
    const tag: CdpChannelTag = {
      port: channelPort,
      browserUrl,
      taggedAt: new Date().toISOString(),
    };
    const key = `${CDP_DRIVER_TAG_PREFIX}${channelPort}`;
    await cdp.send(
      "Runtime.evaluate",
      {
        expression: `chrome.storage.local.set({${JSON.stringify(key)}: ${JSON.stringify(tag)}})`,
        awaitPromise: true,
      },
      attached.sessionId,
    );
    await cdp.send("Target.detachFromTarget", { sessionId: attached.sessionId }).catch(() => {});
    return true;
  } catch {
    return false;
  } finally {
    cdp?.close();
  }
}

/**
 * Remove this channel's roster entry — the clean-shutdown half of the
 * contract (readers also staleness-filter, so a CRASH ages out on its own;
 * ext/manifest.ts CDP_DRIVER_TAG_FRESH_MS). Same wire shape as tagOnce.
 */
export async function untagOnce(
  browserUrl: string,
  channelPort: number,
  socketFactory?: (url: string) => CdpSocket,
): Promise<boolean> {
  const wsUrl = await browserWsUrl(browserUrl);
  if (wsUrl === undefined) {
    return false;
  }
  let cdp: CdpConnection | undefined;
  try {
    cdp = await connectCdp(wsUrl, socketFactory);
    const targets = (await cdp.send("Target.getTargets")) as {
      targetInfos?: Array<{ targetId: string; type: string; url: string }>;
    };
    const worker = targets.targetInfos?.find(
      (t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${EXTENSION_ID}/`),
    );
    if (worker === undefined) {
      return false;
    }
    const attached = (await cdp.send("Target.attachToTarget", {
      targetId: worker.targetId,
      flatten: true,
    })) as { sessionId?: string };
    if (attached.sessionId === undefined) {
      return false;
    }
    const key = `${CDP_DRIVER_TAG_PREFIX}${channelPort}`;
    await cdp.send(
      "Runtime.evaluate",
      {
        expression: `chrome.storage.local.remove(${JSON.stringify(key)})`,
        awaitPromise: true,
      },
      attached.sessionId,
    );
    await cdp.send("Target.detachFromTarget", { sessionId: attached.sessionId }).catch(() => {});
    return true;
  } catch {
    return false;
  } finally {
    cdp?.close();
  }
}

/**
 * How often a LANDED tag is re-affirmed. A roster entry in
 * `chrome.storage.local` survives worker sleep, but not an extension
 * reinstall or a fresh profile that happens to reuse the port — a slow
 * re-write covers both, invisibly. Readers drop entries older than
 * CDP_DRIVER_TAG_FRESH_MS (ext/manifest.ts), so a crashed channel's entry
 * ages out on its own.
 */
const REAFFIRM_MS = 60_000;

/** Whether (and where) the tagger's write has landed — the channel side of
 * the CDP-ALIGNMENT evidence (`/intent/cdp/info` serves it; the client's
 * cdp-align.ts consumes it). */
export interface TaggerStatus {
  /** The tag landed in some browser's copy of the extension. */
  tagged: boolean;
  /** The endpoint it landed through, when tagged. */
  browserUrl?: string;
  /** When it last landed (ISO), when tagged. */
  taggedAt?: string;
}

export interface CdpTagger {
  stop(): void;
  status(): TaggerStatus;
}

/** Start the tagging loop. Returns the handle (stopper + landed status). */
export function startCdpTagger(options: TaggerOptions): CdpTagger {
  const log = options.log ?? (() => {});
  const interval = options.intervalMs ?? 5000;
  let stopped = false;
  let taggedFor: string | undefined; // `${browserUrl}#${port}` last landed
  let taggedUrl: string | undefined; // the endpoint of that landing
  let taggedAtMs = 0;
  const tick = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    const port = options.channelPort();
    const browserUrl = await options.endpoint();
    if (port !== undefined && browserUrl !== undefined) {
      const key = `${browserUrl}#${port}`;
      const due = taggedFor !== key || Date.now() - taggedAtMs >= REAFFIRM_MS;
      if (due && (await tagOnce(browserUrl, port, options.socketFactory))) {
        if (taggedFor !== key) {
          // Log on the TRANSITION only — the reaffirm beat stays silent.
          log(`cdp tagger: tagged the intent client in ${browserUrl} with channel :${port}`);
        }
        taggedFor = key;
        taggedUrl = browserUrl;
        taggedAtMs = Date.now();
      }
    }
    if (!stopped) {
      setTimeout(() => void tick(), interval);
    }
  };
  void tick();
  return {
    stop: () => {
      stopped = true;
      // Clean shutdown removes OUR roster entry (best-effort — the browser
      // may already be gone; staleness covers that case).
      if (taggedUrl !== undefined) {
        const port = options.channelPort();
        if (port !== undefined) {
          void untagOnce(taggedUrl, port, options.socketFactory);
        }
      }
    },
    status: () =>
      taggedFor !== undefined
        ? {
            tagged: true,
            ...(taggedUrl !== undefined ? { browserUrl: taggedUrl } : {}),
            taggedAt: new Date(taggedAtMs).toISOString(),
          }
        : { tagged: false },
  };
}
