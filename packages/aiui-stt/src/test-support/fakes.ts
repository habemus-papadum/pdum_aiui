/**
 * fakes.ts — the scripted test doubles both engine suites drive: a socket
 * factory the test operates like the vendor (open/message/close/error), and
 * a callbacks recorder. The same seam pattern as the channel's engine tests:
 * no network, no key, every wire fact scripted.
 */

import type { SttSocketFactory, SttSocketHandlers } from "../support";
import type { SttCallbacks, SttDiagnostic, SttFinal } from "../types";

export interface FakeSocket {
  factory: SttSocketFactory;
  /** Raw outbound frames, in send order. */
  sent: string[];
  /** Outbound frames parsed as JSON. */
  sentJson(): Array<Record<string, unknown>>;
  url(): string | undefined;
  protocols(): string[] | undefined;
  closed(): boolean;
  /** Vendor-side controls. */
  open(): void;
  message(frame: object): void;
  error(message: string): void;
  close(code?: number, reason?: string): void;
}

export function fakeSocket(): FakeSocket {
  const sent: string[] = [];
  let handlers: SttSocketHandlers | undefined;
  let url: string | undefined;
  let protocols: string[] | undefined;
  let closed = false;
  const must = (): SttSocketHandlers => {
    if (handlers === undefined) {
      throw new Error("socket not yet constructed by the session");
    }
    return handlers;
  };
  return {
    factory: (u, p, h) => {
      url = u;
      protocols = p;
      handlers = h;
      return {
        send: (text) => sent.push(text),
        close: () => {
          closed = true;
        },
      };
    },
    sent,
    sentJson: () => sent.map((t) => JSON.parse(t) as Record<string, unknown>),
    url: () => url,
    protocols: () => protocols,
    closed: () => closed,
    open: () => must().onOpen(),
    message: (frame) => must().onMessage(JSON.stringify(frame)),
    error: (message) => must().onError(message),
    close: (code, reason) => must().onClose(code, reason),
  };
}

export interface Recorded {
  deltas: Array<[number, string]>;
  finals: Array<[number, SttFinal]>;
  errors: Array<[string, number | undefined]>;
  diagnostics: SttDiagnostic[];
  callbacks: SttCallbacks;
}

export function recordingCallbacks(): Recorded {
  const record: Recorded = {
    deltas: [],
    finals: [],
    errors: [],
    diagnostics: [],
    callbacks: {
      onDelta: (segment, text) => record.deltas.push([segment, text]),
      onFinal: (segment, result) => record.finals.push([segment, result]),
      onError: (message, segment) => record.errors.push([message, segment]),
      onDiagnostic: (diagnostic) => record.diagnostics.push(diagnostic),
    },
  };
  return record;
}

/** PCM16 bytes worth `ms` of audio at 24 kHz (48 bytes/ms). */
export function pcmMs(ms: number): Uint8Array {
  return new Uint8Array(ms * 48);
}
