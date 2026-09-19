/**
 * backend.ts — the HOST-NEUTRAL server side (node-only, the `./node`
 * subpath): the session BROKER (the SDP exchange with the project key the
 * browser must never hold) and the delegation RELAY (a WebSocket that runs a
 * real delegator — Claude Code, a Responses model — on this side of the wire
 * and streams appends back).
 *
 * The pencil playbook's seam: `handleHttp(req, res): boolean` and
 * `handleUpgrade(req, socket, head): boolean` mount identically into a Vite
 * dev server (the `./vite` plugin), a standalone node server
 * ({@link runLiveServer}), and, later, the channel sidecar.
 *
 * Routes (under `prefix`, default `/live`):
 *   GET  <prefix>/info       readiness: keyed?, delegator names
 *   POST <prefix>/sessions   { session, sdp } → { sessionId, sdp }   (201)
 *   WS   <prefix>/delegate   the relay (see ../delegators/relay-protocol)
 *
 * Keyless degrades LOUDLY (503 with the remedy), never silently.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import {
  decodeFrame,
  encodeFrame,
  type RelayClientFrame,
  type RelayServerFrame,
} from "../delegators/relay-protocol.ts";
import { LIVE_BASE_URL, LIVE_SESSIONS_PATH } from "../protocol.ts";
import type { DelegationRequest, Delegator, LiveTool } from "../types.ts";

export interface DelegatorContext {
  sessionId?: string;
  log: (line: string) => void;
}

export type DelegatorFactory = (ctx: DelegatorContext) => Delegator | Promise<Delegator>;

export interface LiveBackendOptions {
  /** Default `process.env.OPENAI_API_KEY`. */
  resolveKey?: () => string | undefined | Promise<string | undefined>;
  baseUrl?: string;
  prefix?: string;
  /** Delegators a browser may ask for by name. */
  delegators?: Record<string, DelegatorFactory>;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
  /** How long a page-owned tool call may take before the backend gives up. */
  toolTimeoutMs?: number;
}

export interface LiveBackend {
  handleHttp(req: IncomingMessage, res: ServerResponse): boolean;
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  delegatorNames(): string[];
  dispose(): void;
}

export interface SessionOutcome {
  status: number;
  body: Record<string, unknown>;
}

/** The broker decision, pure of HTTP plumbing. */
export async function sessionOutcome(
  payload: unknown,
  options: LiveBackendOptions = {},
): Promise<SessionOutcome> {
  const key = await (options.resolveKey ?? (() => process.env.OPENAI_API_KEY))();
  if (key === undefined || key === "") {
    return {
      status: 503,
      body: {
        error:
          "no OPENAI_API_KEY in the server's environment — set it (or `aiui keys set openai` and export it) and restart",
      },
    };
  }
  const record =
    payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const sdp = record.sdp;
  if (typeof sdp !== "string" || sdp.trim() === "") {
    return { status: 400, body: { error: "body must be JSON: { session: {…}, sdp: '<offer>' }" } };
  }
  const session = record.session ?? {};
  if (session === null || typeof session !== "object" || Array.isArray(session)) {
    return { status: 400, body: { error: "session must be an object" } };
  }
  const doFetch = options.fetchImpl ?? fetch;
  try {
    const response = await doFetch(`${options.baseUrl ?? LIVE_BASE_URL}${LIVE_SESSIONS_PATH}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ session, transport: { type: "webrtc", sdp } }),
    });
    const text = await response.text();
    if (!response.ok) {
      return {
        status: response.status === 401 ? 502 : response.status,
        body: { error: `live session creation failed (${response.status}): ${text.slice(0, 300)}` },
      };
    }
    const data = JSON.parse(text) as { session?: { id?: string }; transport?: { sdp?: string } };
    if (typeof data.transport?.sdp !== "string" || typeof data.session?.id !== "string") {
      return { status: 502, body: { error: "live session creation returned no answer" } };
    }
    return { status: 201, body: { sessionId: data.session.id, sdp: data.transport.sdp } };
  } catch (error) {
    return { status: 502, body: { error: error instanceof Error ? error.message : String(error) } };
  }
}

export function createLiveBackend(options: LiveBackendOptions = {}): LiveBackend {
  const prefix = options.prefix ?? "/live";
  const log = options.log ?? (() => {});
  const delegators = options.delegators ?? {};
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<WebSocket>();

  wss.on("connection", (ws: WebSocket) => {
    sockets.add(ws);
    void serveRelay(ws, delegators, { log, toolTimeoutMs: options.toolTimeoutMs ?? 60000 }).finally(
      () => sockets.delete(ws),
    );
  });

  return {
    handleHttp(req, res) {
      const path = (req.url ?? "").split("?")[0];
      if (path === `${prefix}/info`) {
        json(res, 200, {
          ok: true,
          keyed: (process.env.OPENAI_API_KEY ?? "") !== "" || options.resolveKey !== undefined,
          delegators: Object.keys(delegators),
        });
        return true;
      }
      if (path !== `${prefix}/sessions`) {
        return false;
      }
      if (req.method !== "POST") {
        json(res, 405, { error: "POST only" });
        return true;
      }
      readJson(req, 256 * 1024)
        .then((payload) => sessionOutcome(payload, options))
        .then((outcome) => {
          log(
            `live sessions: ${outcome.status}${outcome.status === 201 ? ` ${String(outcome.body.sessionId)}` : ` ${String(outcome.body.error)}`}`,
          );
          json(res, outcome.status, outcome.body);
        })
        .catch((error: unknown) =>
          json(res, 400, { error: error instanceof Error ? error.message : String(error) }),
        );
      return true;
    },
    handleUpgrade(req, socket, head) {
      const path = (req.url ?? "").split("?")[0];
      if (path !== `${prefix}/delegate`) {
        return false;
      }
      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => wss.emit("connection", ws, req));
      return true;
    },
    delegatorNames: () => Object.keys(delegators),
    dispose() {
      for (const ws of sockets) {
        ws.close();
      }
      wss.close();
    },
  };
}

interface RelayOptions {
  log: (line: string) => void;
  toolTimeoutMs: number;
}

async function serveRelay(
  ws: WebSocket,
  factories: Record<string, DelegatorFactory>,
  options: RelayOptions,
): Promise<void> {
  const send = (frame: RelayServerFrame) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(encodeFrame(frame));
    }
  };
  let delegator: Delegator | undefined;
  const aborts = new Map<string, AbortController>();
  const toolWaiters = new Map<
    string,
    { resolve(value: unknown): void; timer: ReturnType<typeof setTimeout> }
  >();
  let toolSeq = 0;

  const callTool = (
    taskId: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> =>
    new Promise((resolve) => {
      const callId = `t_${++toolSeq}`;
      const timer = setTimeout(() => {
        toolWaiters.delete(callId);
        resolve({ error: `tool ${name} timed out after ${options.toolTimeoutMs} ms` });
      }, options.toolTimeoutMs);
      toolWaiters.set(callId, { resolve, timer });
      send({ type: "tool", id: taskId, callId, name, arguments: args });
    });

  await new Promise<void>((done) => {
    ws.on("message", (data: Buffer) => {
      const frame = decodeFrame<RelayClientFrame>(data.toString());
      if (frame === undefined) {
        send({ type: "error", message: "unparseable frame" });
        return;
      }
      switch (frame.type) {
        case "hello": {
          const factory = factories[frame.delegator];
          if (factory === undefined) {
            send({
              type: "error",
              message: `unknown delegator ${frame.delegator} (have: ${Object.keys(factories).join(", ") || "none"})`,
            });
            ws.close();
            return;
          }
          void Promise.resolve()
            .then(() =>
              factory({ sessionId: frame.sessionId, log: (line) => send({ type: "log", line }) }),
            )
            .then((created) => {
              delegator = created;
              options.log(`live relay: ${frame.delegator} for ${frame.sessionId ?? "?"}`);
              send({
                type: "ready",
                delegator: frame.delegator,
                description: created.describe?.(),
              });
            })
            .catch((error: unknown) => {
              send({
                type: "error",
                message: error instanceof Error ? error.message : String(error),
              });
              ws.close();
            });
          return;
        }
        case "delegate": {
          const active = delegator;
          if (active === undefined) {
            send({ type: "failed", id: frame.id, error: "no delegator (send hello first)" });
            return;
          }
          const controller = new AbortController();
          aborts.set(frame.id, controller);
          const tools: LiveTool[] = frame.tools.map((spec) => ({
            ...spec,
            execute: (args) => callTool(frame.id, spec.name, args),
          }));
          const req: DelegationRequest = {
            id: frame.id,
            text: frame.text,
            transcript: frame.transcript,
            tools,
            ...(typeof frame.brief === "string" ? { brief: frame.brief } : {}),
            signal: controller.signal,
            say: async (text) => send({ type: "say", id: frame.id, text }),
            note: async (text) => send({ type: "note", id: frame.id, text }),
            steer: async (text) => send({ type: "steer", id: frame.id, text }),
            log: (line) => send({ type: "log", id: frame.id, line }),
          };
          void Promise.resolve()
            .then(() => active.handle(req))
            .then((result) =>
              send({
                type: "done",
                id: frame.id,
                result: typeof result === "string" ? result : undefined,
              }),
            )
            .catch((error: unknown) =>
              send({
                type: "failed",
                id: frame.id,
                error: error instanceof Error ? error.message : String(error),
              }),
            )
            .finally(() => aborts.delete(frame.id));
          return;
        }
        case "cancel":
          aborts.get(frame.id)?.abort();
          return;
        case "tool_result": {
          const waiter = toolWaiters.get(frame.callId);
          if (waiter !== undefined) {
            clearTimeout(waiter.timer);
            toolWaiters.delete(frame.callId);
            waiter.resolve(frame.output);
          }
          return;
        }
      }
    });
    ws.on("close", () => {
      for (const controller of aborts.values()) {
        controller.abort();
      }
      for (const waiter of toolWaiters.values()) {
        clearTimeout(waiter.timer);
        waiter.resolve({ error: "relay closed" });
      }
      delegator?.dispose?.();
      done();
    });
    ws.on("error", () => ws.close());
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text === "" ? {} : JSON.parse(text));
      } catch {
        reject(new Error("body was not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

/** A standalone server carrying the backend — for a static build of an app
 * that still wants a server-side broker and backend on this machine. */
export async function runLiveServer(
  options: LiveBackendOptions & { port?: number; host?: string } = {},
): Promise<{ port: number; close(): Promise<void> }> {
  const { createServer } = await import("node:http");
  const backend = createLiveBackend(options);
  const log = options.log ?? ((line: string) => console.error(line));
  const prefix = options.prefix ?? "/live";
  const server = createServer((req, res) => {
    if (!backend.handleHttp(req, res)) {
      json(res, 404, {
        error: `not found — routes are ${prefix}/info, POST ${prefix}/sessions, WS ${prefix}/delegate`,
      });
    }
  });
  server.on("upgrade", (req, socket, head) => {
    if (!backend.handleUpgrade(req, socket, head)) {
      socket.destroy();
    }
  });
  await new Promise<void>((resolve) =>
    server.listen(options.port ?? 8790, options.host ?? "127.0.0.1", resolve),
  );
  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : (options.port ?? 8790);
  log(`live backend on http://${options.host ?? "127.0.0.1"}:${port}${prefix}`);
  return {
    port,
    close: () =>
      new Promise((resolve) => {
        backend.dispose();
        server.close(() => resolve());
      }),
  };
}
