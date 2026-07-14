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
 * SELF-VERIFYING: an extension that finds `aiui2.cdpChannel` KNOWS this
 * browser is the one that channel drives — discovery and same-browser proof
 * in one fact. (It also beats native messaging for cold-start discovery in
 * the session browser: a fresh install with zero remembered ports finds its
 * channel from the tag.)
 *
 * Lifecycle: an idle MV3 worker has no CDP target, so the tagger RETRIES on
 * a short beat until it lands, then keeps watching — a worker restart or a
 * different browser appearing behind the endpoint re-tags. Best-effort by
 * design: no browser, no extension, no problem — it just keeps trying
 * quietly (one log line per state change).
 */

import { CDP_CHANNEL_TAG_KEY, EXTENSION_ID } from "../ext/manifest";
import { type CdpConnection, type CdpSocket, connectCdp } from "./protocol";

export { CDP_CHANNEL_TAG_KEY };

/** What the write puts under {@link CDP_CHANNEL_TAG_KEY}. */
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
    await cdp.send(
      "Runtime.evaluate",
      {
        expression: `chrome.storage.local.set({${JSON.stringify(CDP_CHANNEL_TAG_KEY)}: ${JSON.stringify(tag)}})`,
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
 * How often a LANDED tag is re-affirmed. A tag in `chrome.storage.local`
 * survives worker sleep, but not an extension reinstall or a fresh profile
 * that happens to reuse the port — a slow re-write covers both, invisibly.
 */
const REAFFIRM_MS = 60_000;

/** Start the tagging loop. Returns the stopper. */
export function startCdpTagger(options: TaggerOptions): () => void {
  const log = options.log ?? (() => {});
  const interval = options.intervalMs ?? 5000;
  let stopped = false;
  let taggedFor: string | undefined; // `${browserUrl}#${port}` last landed
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
        taggedAtMs = Date.now();
      }
    }
    if (!stopped) {
      setTimeout(() => void tick(), interval);
    }
  };
  void tick();
  return () => {
    stopped = true;
  };
}
