/**
 * remote.ts — the browser half of a hosted delegator: forward each
 * delegation over our own WebSocket to a server that runs the real backend
 * (`createLiveBackend` in `./node`), and turn its frames back into appends.
 * Page-owned tools round-trip: the server asks, the page executes, the page
 * answers — so Claude Code on the server can move a slider in the browser.
 */

import type { DelegationRequest, Delegator } from "../types";
import { toolSpec } from "../types";
import {
  decodeFrame,
  encodeFrame,
  type RelayClientFrame,
  type RelayServerFrame,
} from "./relay-protocol";

export interface RemoteDelegatorOptions {
  /** The relay URL (`ws://host/live/delegate`) or a same-origin path. */
  url?: string;
  /** Which server-side delegator to ask for. Default `claude`. */
  delegator?: string;
  sessionId?: string;
  WebSocketImpl?: typeof WebSocket;
  /** Server log lines that are not for a task. */
  onLog?: (line: string) => void;
}

interface Inflight {
  req: DelegationRequest;
  resolve(result: string | undefined): void;
  reject(error: Error): void;
  /** Keeps spoken frames in order. */
  chain: Promise<void>;
}

export function remoteDelegator(options: RemoteDelegatorOptions = {}): Delegator {
  const name = options.delegator ?? "claude";
  const Impl = options.WebSocketImpl ?? WebSocket;
  let socket: WebSocket | undefined;
  let ready: Promise<void> | undefined;
  const inflight = new Map<string, Inflight>();
  let description = "";

  const resolveUrl = () => {
    const url = options.url ?? "/live/delegate";
    if (/^wss?:/.test(url)) {
      return url;
    }
    const base =
      typeof location === "undefined" ? "ws://localhost" : location.origin.replace(/^http/, "ws");
    return `${base}${url.startsWith("/") ? "" : "/"}${url}`;
  };

  const open = (): Promise<void> => {
    if (socket !== undefined && socket.readyState === Impl.OPEN && ready !== undefined) {
      return ready;
    }
    const ws = new Impl(resolveUrl());
    socket = ws;
    ready = new Promise<void>((resolve, reject) => {
      const fail = (message: string) => {
        reject(new Error(message));
        for (const item of inflight.values()) {
          item.reject(new Error(message));
        }
        inflight.clear();
      };
      ws.onopen = () => {
        ws.send(
          encodeFrame({
            type: "hello",
            delegator: name,
            sessionId: options.sessionId,
          } satisfies RelayClientFrame),
        );
      };
      ws.onerror = () => fail("relay socket error");
      ws.onclose = (event) => fail(`relay closed (${event.code})`);
      ws.onmessage = (event) => {
        const frame = decodeFrame<RelayServerFrame>(String(event.data));
        if (frame === undefined) {
          return;
        }
        if (frame.type === "ready") {
          description = frame.description ?? "";
          resolve();
          return;
        }
        if (frame.type === "error") {
          options.onLog?.(`relay: ${frame.message}`);
          return;
        }
        if (frame.type === "log" && frame.id === undefined) {
          options.onLog?.(frame.line);
          return;
        }
        const id = (frame as { id?: string }).id;
        const item = id === undefined ? undefined : inflight.get(id);
        if (item === undefined || id === undefined) {
          return;
        }
        switch (frame.type) {
          case "say":
          case "note":
          case "steer": {
            const fn =
              frame.type === "say"
                ? item.req.say
                : frame.type === "note"
                  ? item.req.note
                  : item.req.steer;
            item.chain = item.chain.then(() => fn(frame.text)).catch(() => {});
            break;
          }
          case "log":
            item.req.log(frame.line);
            break;
          case "tool": {
            const tool = item.req.tools.find((candidate) => candidate.name === frame.name);
            void Promise.resolve()
              .then(() =>
                tool === undefined
                  ? { error: `unknown tool ${frame.name}` }
                  : tool.execute(frame.arguments, { caller: `live:${name}`, ref: item.req.id }),
              )
              .catch((error: unknown) => ({
                error: error instanceof Error ? error.message : String(error),
              }))
              .then((output) => {
                ws.send(
                  encodeFrame({
                    type: "tool_result",
                    callId: frame.callId,
                    output: output ?? { ok: true },
                  }),
                );
              });
            break;
          }
          case "done":
            void item.chain.then(() => {
              inflight.delete(id);
              item.resolve(frame.result);
            });
            break;
          case "failed":
            void item.chain.then(() => {
              inflight.delete(id);
              item.reject(new Error(frame.error));
            });
            break;
        }
      };
    });
    return ready;
  };

  return {
    name,
    describe: () => (description === "" ? `remote:${name}` : `remote:${name} — ${description}`),
    async handle(req) {
      await open();
      const ws = socket;
      if (ws === undefined) {
        throw new Error("relay not open");
      }
      return new Promise<string | undefined>((resolve, reject) => {
        inflight.set(req.id, { req, resolve, reject, chain: Promise.resolve() });
        req.signal.addEventListener(
          "abort",
          () => {
            if (inflight.has(req.id)) {
              ws.send(encodeFrame({ type: "cancel", id: req.id }));
              inflight.delete(req.id);
              reject(new Error("cancelled"));
            }
          },
          { once: true },
        );
        ws.send(
          encodeFrame({
            type: "delegate",
            id: req.id,
            text: req.text,
            transcript: req.transcript,
            tools: req.tools.map(toolSpec),
            ...(req.brief !== undefined ? { brief: req.brief } : {}),
          }),
        );
      });
    },
    dispose() {
      socket?.close();
      socket = undefined;
      ready = undefined;
    },
  };
}
