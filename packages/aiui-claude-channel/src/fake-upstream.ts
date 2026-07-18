/**
 * The shared scripted fake of a realtime upstream socket, used by all four
 * session test suites (the two STT engines and the two live linter engines). It
 * captures the connect url/key and every message the session sends (parsed), and
 * lets the test drive the server side: `open()` fires the socket open, `emit()`
 * and `raw()` deliver server frames, `error()`/`serverClose()` drive transport
 * faults. The whole realtime path runs offline and keyless through this seam —
 * the reason the socket factory is injectable (mirroring `transcribe.ts`'s
 * injected `fetch`).
 *
 * This is the ElevenLabs superset shape; each vendor's former local fake was a
 * strict subset of it. NOT a `*.test.ts` file (so vitest's glob skips it), and
 * excluded from the tsc declaration build (tsconfig.json) since no production
 * module imports it.
 */
import type { RealtimeSocketFactory, RealtimeSocketHandlers } from "./realtime";

export interface FakeUpstream {
  factory: RealtimeSocketFactory;
  /** The connect URL the factory was handed (config can live in its query string). */
  url?: string;
  /** The api key the factory was handed. */
  apiKey?: string;
  /** Parsed JSON of every message the session sent upstream. */
  sent: Array<Record<string, unknown>>;
  /** True once the session closed the socket. */
  closed: boolean;
  /** Fire the socket's open (some vendors respond with a config frame, some send nothing). */
  open(): void;
  /** Deliver a server event to the session. */
  emit(message: Record<string, unknown>): void;
  /** Deliver a raw (possibly malformed) upstream frame. */
  raw(text: string): void;
  /** Fire a transport-level error. */
  error(message: string, data?: unknown): void;
  /** Fire a server-initiated close (code/reason ride the fail message). */
  serverClose(code?: number, reason?: string): void;
}

export function fakeUpstream(): FakeUpstream {
  let handlers: RealtimeSocketHandlers | undefined;
  const up: FakeUpstream = {
    sent: [],
    closed: false,
    factory: (url, apiKey, h) => {
      handlers = h;
      up.url = url;
      up.apiKey = apiKey;
      return {
        send: (text) => up.sent.push(JSON.parse(text)),
        close: () => {
          up.closed = true;
          handlers?.onClose();
        },
      };
    },
    open: () => handlers?.onOpen(),
    emit: (message) => handlers?.onMessage(JSON.stringify(message)),
    raw: (text) => handlers?.onMessage(text),
    error: (message, data) => handlers?.onError(message, data),
    serverClose: (code, reason) => handlers?.onClose(code, reason),
  };
  return up;
}
