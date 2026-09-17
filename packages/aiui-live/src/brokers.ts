/**
 * brokers.ts — how a browser gets a session. GPT-Live has NO ephemeral
 * keys: the SDP offer is exchanged for an answer by `POST /v1/live/sessions`
 * with the PROJECT key. So the question is where that key lives:
 *
 *  - PASTED (`sk-…` in localStorage, the same slot the oracle uses): the user
 *    knowingly holds their own key in their own browser; CORS on the sessions
 *    route is open (measured), so the POST goes straight to the vendor;
 *  - DEV (the aiui Vite plugin's `devKeys` injection, serve-only): a static
 *    app under development just works;
 *  - SERVER (`POST /live/sessions` on our own origin): the channel, the Vite
 *    plugin, or any little server does the exchange with a key it holds.
 *
 * The canonical chain is paste → dev → server, the oracle's decided order.
 */

import { LIVE_BASE_URL, LIVE_SESSIONS_PATH, type LiveSessionConfig } from "./protocol";

/** The localStorage slot shared with `@habemus-papadum/aiui-oracle`'s key
 * widget — one paste covers every voice front on the origin. */
export const PASTED_KEY_STORAGE_KEY = "aiui.oracle.key";

export interface SessionAnswer {
  sdp: string;
  sessionId: string;
  /** Which broker produced it. */
  source: string;
}

export interface SessionBroker {
  describe(): string;
  create(offerSdp: string, session: LiveSessionConfig): Promise<SessionAnswer>;
}

export interface DirectBrokerOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/** The vendor exchange, done right here with a key we hold. */
export function directBroker(
  key: string | (() => string | undefined),
  options: DirectBrokerOptions = {},
): SessionBroker {
  return {
    describe: () => "direct",
    async create(offerSdp, session) {
      const resolved = typeof key === "function" ? key() : key;
      if (resolved === undefined || resolved === "") {
        throw new Error("no key");
      }
      const doFetch = options.fetchImpl ?? fetch;
      const response = await doFetch(`${options.baseUrl ?? LIVE_BASE_URL}${LIVE_SESSIONS_PATH}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${resolved}`, "Content-Type": "application/json" },
        body: JSON.stringify({ session, transport: { type: "webrtc", sdp: offerSdp } }),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`live session creation failed (${response.status}): ${body.slice(0, 300)}`);
      }
      const data = (await response.json()) as {
        session?: { id?: string };
        transport?: { sdp?: string };
      };
      if (typeof data.transport?.sdp !== "string" || typeof data.session?.id !== "string") {
        throw new Error("live session creation returned no answer");
      }
      return { sdp: data.transport.sdp, sessionId: data.session.id, source: "direct" };
    },
  };
}

export function pasteKeyBroker(
  storage: Pick<Storage, "getItem"> = localStorage,
  options: DirectBrokerOptions = {},
): SessionBroker {
  const inner = directBroker(() => storage.getItem(PASTED_KEY_STORAGE_KEY)?.trim(), options);
  return {
    describe: () => "paste-key",
    async create(offerSdp, session) {
      const key = storage.getItem(PASTED_KEY_STORAGE_KEY)?.trim();
      if (key === undefined || key === "") {
        throw new Error("no key pasted");
      }
      return { ...(await inner.create(offerSdp, session)), source: "paste-key" };
    },
  };
}

/** The dev-serve key at `window.__AIUI__.devKeys[vendor]`. */
export function devKey(vendor = "openai"): string | undefined {
  const aiui = (globalThis as Record<string, unknown>).__AIUI__ as
    | { devKeys?: Record<string, string> }
    | undefined;
  const key = aiui?.devKeys?.[vendor];
  return typeof key === "string" && key !== "" ? key : undefined;
}

export function devKeyBroker(vendor = "openai", options: DirectBrokerOptions = {}): SessionBroker {
  const inner = directBroker(() => devKey(vendor), options);
  return {
    describe: () => `dev-key:${vendor}`,
    async create(offerSdp, session) {
      if (devKey(vendor) === undefined) {
        throw new Error(`no ${vendor} dev key injected (the aiui vite plugin's devKeys option)`);
      }
      return { ...(await inner.create(offerSdp, session)), source: `dev-key:${vendor}` };
    },
  };
}

export interface ServerBrokerOptions {
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
}

/** Our own origin does the exchange: `POST url { session, sdp }` →
 * `{ sessionId, sdp }` (the shape `createLiveBackend` serves). */
export function serverBroker(
  url = "/live/sessions",
  options: ServerBrokerOptions = {},
): SessionBroker {
  return {
    describe: () => `server:${url}`,
    async create(offerSdp, session) {
      const doFetch = options.fetchImpl ?? fetch;
      const response = await doFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...options.headers },
        body: JSON.stringify({ session, sdp: offerSdp }),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`session broker failed (${response.status}): ${body.slice(0, 300)}`);
      }
      const data = (await response.json()) as { sessionId?: string; sdp?: string };
      if (typeof data.sdp !== "string" || typeof data.sessionId !== "string") {
        throw new Error("session broker returned no answer");
      }
      return { sdp: data.sdp, sessionId: data.sessionId, source: `server:${url}` };
    },
  };
}

/** First broker to answer wins; a throwing one falls through. */
export function chainBroker(brokers: SessionBroker[]): SessionBroker {
  return {
    describe: () => `chain(${brokers.map((broker) => broker.describe()).join(" → ")})`,
    async create(offerSdp, session) {
      const refusals: string[] = [];
      for (const broker of brokers) {
        try {
          return await broker.create(offerSdp, session);
        } catch (error) {
          refusals.push(
            `${broker.describe()}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      throw new Error(`no broker produced a session — ${refusals.join("; ")}`);
    },
  };
}

export interface StandardBrokersOptions {
  /** The server route, when this app has one. Absent = no server flow. */
  serverUrl?: string;
  storage?: Pick<Storage, "getItem">;
  direct?: DirectBrokerOptions;
  server?: ServerBrokerOptions;
}

/** paste-key → dev-key → server. */
export function standardBrokers(options: StandardBrokersOptions = {}): SessionBroker {
  const brokers: SessionBroker[] = [
    pasteKeyBroker(options.storage ?? localStorage, options.direct ?? {}),
    devKeyBroker("openai", options.direct ?? {}),
  ];
  if (options.serverUrl !== undefined) {
    brokers.push(serverBroker(options.serverUrl, options.server ?? {}));
  }
  return chainBroker(brokers);
}

/** The key an IN-BROWSER backend (a Responses delegator) may use: pasted,
 * else dev-injected. Undefined means "use a server-side backend". */
export function browserKey(
  storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage,
): string | undefined {
  const pasted = storage?.getItem(PASTED_KEY_STORAGE_KEY)?.trim();
  if (pasted !== undefined && pasted !== "") {
    return pasted;
  }
  return devKey("openai");
}
