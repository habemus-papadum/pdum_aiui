/**
 * Vendor-agnostic plumbing shared by the four live upstream sessions — the two
 * STT engines (`realtime.ts`, `elevenlabs-realtime.ts`) and the two conversational
 * linter engines (`openai-live.ts`, `gemini-live.ts`). This is the machinery that
 * is genuinely identical across vendors: the injectable `ws` socket seam, the
 * queue-until-ready send gate, the drain controller, and the failure fan-out.
 *
 * What is NOT here, on purpose: every vendor's wire vocabulary, its event switch,
 * and its documented live-verified quirks (Scribe's self-commit, Gemini's
 * audio-first window rule, OpenAI's item-id binding, the per-vendor commit floors
 * and keepalive). Those stay in the twins, where the file-header post-mortems that
 * explain them live. See `realtime.ts` — it used to be the accidental commons.
 *
 * Package-internal: NOT re-exported from `index.ts`. The migrated socket
 * primitives (closeSuffix, captureUnexpectedResponse, the RealtimeSocket* types,
 * RealtimeDiagnostic) are re-exported by `realtime.ts` so the sessions and the
 * root barrel keep importing them from `./realtime`.
 */
import WebSocket from "ws";
import type { LinterToolCall } from "./live-session";

/**
 * Something the vendor did that the session did not act on, or acted on in a way
 * worth recording. Purely observational — a diagnostic never changes control
 * flow, and a caller may ignore them all. They exist because every silent
 * `default: return` in a vendor message switch is a place transcript can vanish
 * without a trace: Scribe self-committed utterances for months and the channel
 * dropped every one of them, unseen, because the drop was a bare `return`.
 *
 *  - `config-echo` — the vendor's own report of the session config it applied.
 *    The ONLY proof a connect-URL param took effect (unknown params are accepted
 *    silently), so it is recorded verbatim and diffed against what we asked for.
 *  - `config-mismatch` — a param we set that the echo does not confirm.
 *  - `vendor-commit` — the vendor closed an utterance we never asked it to close.
 *  - `orphan-result` — a terminal frame that matched no segment at all.
 *  - `unhandled` — a message type this session does not understand.
 */
export type RealtimeDiagnostic =
  | { kind: "config-echo"; config: Record<string, unknown> }
  | { kind: "config-mismatch"; param: string; requested: unknown; echoed: unknown }
  | { kind: "vendor-commit"; segment: number; chars: number; words: number }
  | { kind: "orphan-result"; messageType: string; chars: number }
  | { kind: "unhandled"; messageType: string; raw: string };

/**
 * The minimal upstream socket the session drives — a subset of `ws`'s surface,
 * so a test can supply a scripted fake with no network. The factory wires the
 * handlers; the returned object is what the session sends on / closes.
 */
export interface RealtimeSocket {
  send(text: string): void;
  close(): void;
}

/** Handlers the session hands the factory to observe the upstream socket. */
export interface RealtimeSocketHandlers {
  onOpen(): void;
  onMessage(text: string): void;
  /**
   * A transport fault. `data` optionally carries the structured upstream
   * payload (e.g. a rejected handshake's HTTP status + response body) so the
   * session can surface what the API actually said, not just a summary line.
   */
  onError(message: string, data?: unknown): void;
  /**
   * The socket closed. Vendors report *why* in the close frame — Gemini puts
   * the real error text ("API key not valid …") in `reason` — so the factory
   * forwards both when it has them; handlers that ignore them are unchanged.
   */
  onClose(code?: number, reason?: string): void;
}

/** Builds the upstream socket for one session (real `ws` in prod, a fake in tests). */
export type RealtimeSocketFactory = (
  url: string,
  apiKey: string,
  handlers: RealtimeSocketHandlers,
) => RealtimeSocket;

/**
 * Render a close frame's code/reason as a parenthesized suffix for a
 * "session closed" fault message — `" (1007: API key not valid …)"` — or ""
 * when the factory had neither (a scripted test fake, an abrupt teardown).
 * The reason is where vendors state the actual error, so it leads the text
 * a human reads.
 */
export function closeSuffix(code?: number, reason?: string): string {
  const trimmed = reason?.trim() ?? "";
  if (code === undefined && trimmed === "") {
    return "";
  }
  if (code === undefined) {
    return ` (${trimmed})`;
  }
  return trimmed === "" ? ` (${code})` : ` (${code}: ${trimmed})`;
}

/**
 * The slice of `ws`'s `unexpected-response` event this module reads — the
 * request (to abort) and a readable response with a status code. Structural,
 * so the unit test drives it with plain emitters instead of a real socket.
 */
export interface UnexpectedResponseSource {
  on(
    event: "unexpected-response",
    listener: (
      request: { destroy(): void },
      response: {
        statusCode?: number | undefined;
        on(event: "data", listener: (chunk: Buffer) => void): unknown;
        on(event: "end", listener: () => void): unknown;
      },
    ) => void,
  ): unknown;
}

/**
 * Attach a `ws` `unexpected-response` listener that reads the rejected
 * handshake's HTTP status and body and reports them through `onError`. Without
 * a listener, `ws` reduces a rejected upgrade to `"Unexpected server response:
 * 403"` — discarding the response body where the API states the actual problem.
 * The body is capped (these are small JSON error payloads) and parsed when it
 * is JSON so the structured form rides `onError`'s `data`.
 */
export function captureUnexpectedResponse(
  ws: UnexpectedResponseSource,
  handlers: RealtimeSocketHandlers,
): void {
  ws.on("unexpected-response", (request, response) => {
    const chunks: Buffer[] = [];
    let size = 0;
    response.on("data", (chunk: Buffer) => {
      if (size < 4096) {
        chunks.push(chunk);
        size += chunk.length;
      }
    });
    response.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8").slice(0, 4096).trim();
      let data: unknown = body === "" ? undefined : body;
      let summary = body;
      try {
        const parsed = JSON.parse(body) as { error?: { message?: unknown } };
        data = parsed;
        if (typeof parsed?.error?.message === "string") {
          summary = parsed.error.message;
        }
      } catch {
        // not JSON — the raw (capped) text is still better than nothing
      }
      handlers.onError(
        `upstream rejected the connection (HTTP ${response.statusCode})${summary ? `: ${summary}` : ""}`,
        data,
      );
      request.destroy();
    });
  });
}

/**
 * The one real `ws` wiring the three vendor factories share. `auth` is the only
 * per-vendor difference: it maps the base url + key to the actual connect url and
 * request headers (OpenAI a `Bearer` header, ElevenLabs an `xi-api-key` header,
 * Gemini the key on the query string with no headers). Everything else — the
 * open/message/error/close-with-code-reason event wiring and the
 * {@link captureUnexpectedResponse} handshake-body capture — is identical.
 *
 * Server-side only; the channel always runs under Node, where `ws` is a dependency.
 */
export function makeWsSocketFactory(
  auth: (url: string, apiKey: string) => { url: string; headers?: Record<string, string> },
): RealtimeSocketFactory {
  return (url, apiKey, handlers) => {
    const resolved = auth(url, apiKey);
    const ws = new WebSocket(
      resolved.url,
      resolved.headers ? { headers: resolved.headers } : undefined,
    );
    ws.on("open", () => handlers.onOpen());
    ws.on("message", (data: unknown) => handlers.onMessage(String(data)));
    ws.on("error", (err: Error) => handlers.onError(err.message));
    // Vendors report auth/quota faults in the close frame's reason ("API key not
    // valid …"), so code+reason must reach the session — a bare onClose() reduces
    // every failure to "session closed" with the cause discarded.
    ws.on("close", (code: number, reason: Buffer) => handlers.onClose(code, reason.toString()));
    captureUnexpectedResponse(ws, handlers);
    return {
      send: (text) => ws.send(text),
      close: () => ws.close(),
    };
  };
}

/**
 * The queue-until-ready send gate every session shares. Frames sent before the
 * vendor's ready signal are buffered; `markReady()` flushes them, in enqueue
 * order, and lets subsequent sends go straight through. All four sessions have a
 * handshake that produces readiness (OpenAI/ElevenLabs `session.updated` /
 * `session_started`, Gemini `setupComplete`) which itself goes out on `onOpen`,
 * bypassing this gate.
 *
 * `onSent` fires ONLY on a real socket send — never on a buffered enqueue. That
 * distinction is load-bearing: ElevenLabs arms its idle keepalive from every real
 * outbound frame, and arming it on a pre-ready enqueue would re-arm the timer
 * during buffering. The flush counts as a real send, so it fires there.
 *
 * `rawSend` is a lazy lambda (`(t) => socket.send(t)`) because the socket is
 * defined after the handlers close over the gate — the deref only happens when a
 * send actually runs, by which point the socket exists.
 */
export interface ReadyGate {
  /** Send now if ready, else buffer until {@link markReady}. */
  send(text: string): void;
  /** The vendor signalled ready: flush the buffer in enqueue order, then pass sends through. */
  markReady(): void;
  /** The session is dead: drop further sends (and buffering). */
  markDead(): void;
  isDead(): boolean;
}

export function createReadyGate(
  rawSend: (text: string) => void,
  opts?: { onSent?: () => void },
): ReadyGate {
  let ready = false;
  let dead = false;
  const outbox: string[] = [];
  const realSend = (text: string): void => {
    rawSend(text);
    opts?.onSent?.();
  };
  return {
    send(text) {
      if (ready && !dead) {
        realSend(text);
      } else if (!dead) {
        outbox.push(text);
      }
    },
    markReady() {
      ready = true;
      for (const queued of outbox.splice(0)) {
        realSend(queued);
      }
    },
    markDead() {
      dead = true;
    },
    isDead() {
      return dead;
    },
  };
}

/**
 * The drain controller both STT sessions share: `drain(timeoutMs)` resolves when
 * every outstanding committed segment has produced its final, or the timeout
 * elapses — whichever first — returning the ordinals STILL outstanding, snapshotted
 * at RESOLUTION time (not at the `drain()` call). `settleIfIdle()` resolves waiters
 * once nothing is outstanding; `releaseAll()` backs `close()` so `fin` never hangs
 * on a torn-down socket.
 *
 * `outstanding()` is the twin's own view of what is still in flight — realtime's
 * `[...pending]`, ElevenLabs' `committed.map(c => c.segment)` — and is read fresh
 * on every call so the resolved snapshot reflects the queue as it stands when the
 * timer or the last settle fires.
 */
export interface DrainController {
  settleIfIdle(): void;
  drain(timeoutMs: number): Promise<number[]>;
  releaseAll(): void;
}

export function createDrainController(outstanding: () => number[]): DrainController {
  const waiters: Array<() => void> = [];
  return {
    settleIfIdle() {
      if (outstanding().length === 0) {
        for (const resolve of waiters.splice(0)) {
          resolve();
        }
      }
    },
    drain(timeoutMs) {
      if (outstanding().length === 0) {
        return Promise.resolve([]);
      }
      return new Promise<number[]>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve(outstanding());
        };
        const timer = setTimeout(finish, timeoutMs);
        waiters.push(finish);
      });
    },
    releaseAll() {
      for (const resolve of waiters.splice(0)) {
        resolve();
      }
    },
  };
}

/**
 * The shared tail of both STT sessions' session-wide failure: report the fault
 * per outstanding segment loudly (so the caller finalizes each one), or once
 * session-wide when nothing was in flight. This absorbs ONLY the `onError`
 * fan-out — each twin still does its own state teardown (ElevenLabs clears its
 * keepalive + pending; realtime clears `commitAt` per segment) BEFORE calling
 * this. `onError` matches `RealtimeCallbacks['onError']`.
 */
export function reportSessionFailure(
  onError: (message: string, segment?: number) => void,
  message: string,
  segments: number[],
): void {
  for (const segment of segments) {
    onError(message, segment);
  }
  if (segments.length === 0) {
    onError(message);
  }
}

/**
 * The MIME every live engine's streamed reply chunk carries: raw PCM16 mono at
 * 24 kHz — both vendors emit exactly this, so the client player decodes one
 * format. (The whole-clip WAV wrap died with the buffering: replies STREAM —
 * the house rule, like the REST-transcription retirement. TTS acks, which are
 * genuinely whole little files, still ride `audio/mpeg` clips.)
 */
export const REPLY_PCM_MIME = "audio/pcm;rate=24000";

/**
 * The reply-TRANSCRIPT accumulator the live engines share (streamed via
 * {@link appendTranscript} or set absolute via {@link setTranscript});
 * {@link flush} emits the trimmed text and clears. Audio is deliberately NOT
 * accumulated here anymore — each PCM delta is forwarded to the callbacks the
 * moment it arrives (streaming playback; whole-clip buffering retired
 * 2026-07-19: it delayed the first audible byte by the entire reply's
 * generation time). Gemini holds ONE instance and {@link reset}s it on a
 * barge-in `interrupted`; OpenAI holds a Map keyed by response id (which may
 * be the empty string) and flushes per `response.done`.
 */
export interface ReplyTranscript {
  appendTranscript(t: string): void;
  setTranscript(t: string): void;
  flush(): void;
  reset(): void;
}

export function createReplyTranscript(cb: { onTranscript(text: string): void }): ReplyTranscript {
  let transcript = "";
  return {
    appendTranscript(t) {
      transcript += t;
    },
    setTranscript(t) {
      transcript = t;
    },
    flush() {
      const text = transcript.trim();
      if (text !== "") {
        cb.onTranscript(text);
      }
      transcript = "";
    },
    reset() {
      transcript = "";
    },
  };
}

/**
 * The once-guarded linter tool call both live engines build: `respond` writes the
 * result at most once, and never after the session is dead. The vendor wire is the
 * `sendResponse` lambda — OpenAI writes a `function_call_output` then a
 * `response.create` (its resume rule); Gemini writes one `toolResponse` (it
 * resumes on its own).
 */
export function makeOnceCall(
  name: string,
  args: Record<string, unknown>,
  isDead: () => boolean,
  sendResponse: (result: string) => void,
): LinterToolCall {
  let responded = false;
  return {
    tool: name,
    args,
    respond: (result: string) => {
      if (responded || isDead()) {
        return;
      }
      responded = true;
      sendResponse(result);
    },
  };
}
