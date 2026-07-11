/**
 * A tiny typed request/response layer over `chrome.runtime` messaging, shared
 * by every extension surface (panel ↔ service worker ↔ content scripts ↔
 * offscreen documents).
 *
 * `chrome.runtime.sendMessage` broadcasts to every listening context, so each
 * envelope is addressed (`to`) and named (`cmd`); a context serves a set of
 * commands under its address via {@link serveRelay} and callers use
 * {@link relayRequest} / {@link relayRequestTab}. Results travel as a tagged
 * union so a thrown handler error reaches the caller as a rejection with the
 * original message, not a silent `undefined` (the MV3 default when a handler
 * throws before `sendResponse`).
 *
 * The envelope/result codecs are pure and exported for tests; only the
 * `serve`/`request` functions touch `chrome.*`.
 */

/** The wire envelope. `aiui: 1` guards against foreign runtime messages. */
export interface RelayEnvelope {
  aiui: 1;
  to: string;
  cmd: string;
  payload?: unknown;
}

/** The wire result: a tagged union so errors survive the messaging boundary. */
export type RelayResult = { ok: true; value: unknown } | { ok: false; error: string };

/** True when `msg` is a relay envelope addressed to `to`. Pure. */
export function isRelayEnvelope(msg: unknown, to: string): msg is RelayEnvelope {
  if (msg === null || typeof msg !== "object") {
    return false;
  }
  const m = msg as Partial<RelayEnvelope>;
  return m.aiui === 1 && m.to === to && typeof m.cmd === "string";
}

/** Wrap a handler outcome as a {@link RelayResult}. Pure. */
export function toRelayResult(outcome: { value?: unknown; error?: unknown }): RelayResult {
  if ("error" in outcome && outcome.error !== undefined) {
    const e = outcome.error;
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  return { ok: true, value: outcome.value };
}

/** Unwrap a {@link RelayResult}, throwing the marshalled error. Pure. */
export function fromRelayResult<T>(result: unknown): T {
  const r = result as RelayResult | undefined;
  if (r === undefined || typeof r !== "object" || typeof (r as RelayResult).ok !== "boolean") {
    throw new Error("relay: malformed or missing response (is the target context alive?)");
  }
  if (!r.ok) {
    throw new Error(r.error);
  }
  return r.value as T;
}

/** One command's implementation. May be async; thrown errors are marshalled. */
export type RelayHandler = (
  payload: unknown,
  sender: chrome.runtime.MessageSender,
) => unknown | Promise<unknown>;

/**
 * Serve a set of commands under an address. Returns a disposer. One listener
 * per call; unknown commands under this address answer with an error so a
 * typo'd caller fails fast instead of timing out.
 */
export function serveRelay(to: string, handlers: Record<string, RelayHandler>): () => void {
  const listener = (
    msg: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: RelayResult) => void,
  ): boolean => {
    if (!isRelayEnvelope(msg, to)) {
      return false;
    }
    const handler = handlers[msg.cmd];
    if (handler === undefined) {
      sendResponse(toRelayResult({ error: `relay: unknown command "${to}/${msg.cmd}"` }));
      return false;
    }
    void (async () => {
      try {
        sendResponse(toRelayResult({ value: await handler(msg.payload, sender) }));
      } catch (error) {
        sendResponse(toRelayResult({ error }));
      }
    })();
    return true; // keep sendResponse alive for the async handler
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

/** Send `cmd` to the extension context serving `to` and await its result. */
export async function relayRequest<T = unknown>(
  to: string,
  cmd: string,
  payload?: unknown,
): Promise<T> {
  const envelope: RelayEnvelope = {
    aiui: 1,
    to,
    cmd,
    ...(payload !== undefined ? { payload } : {}),
  };
  return fromRelayResult<T>(await chrome.runtime.sendMessage(envelope));
}

/** Send `cmd` to a specific tab's content script (address `to`) and await it. */
export async function relayRequestTab<T = unknown>(
  tabId: number,
  to: string,
  cmd: string,
  payload?: unknown,
): Promise<T> {
  const envelope: RelayEnvelope = {
    aiui: 1,
    to,
    cmd,
    ...(payload !== undefined ? { payload } : {}),
  };
  return fromRelayResult<T>(await chrome.tabs.sendMessage(tabId, envelope));
}
