/**
 * The page-tool directory: the channel's registry of tools that live *in the
 * browser*.
 *
 * A dev page (via the aiui dev overlay's tools bridge) opens a websocket to the
 * channel's `/tools` endpoint and declares the tools it exposes — name,
 * description, JSON Schema — for the whole namespace at once. The channel keeps
 * that declaration here; the MCP layer surfaces it to the Claude Code session
 * (`page_tools_list`), and a call (`page_tools_call`) is routed back over the
 * same socket to the live page function, whose result returns the same way.
 *
 * This module is transport-agnostic — a connection is just an id plus a `send`
 * function — so the whole thing is unit-testable without a real websocket (see
 * page-tools.test.ts). web.ts wires it to the `/tools` websocket; the wire
 * protocol is documented in docs/websocket-protocol.md.
 *
 * Nothing here may write to stdout: in the `mcp` command that stream carries the
 * MCP stdio protocol. The change-log line goes through {@link
 * PageToolDirectoryOptions.log}, which defaults to stderr.
 */
import { randomUUID } from "node:crypto";
import type { SourceInfo, TabInfo } from "./frame";

/** One tool a page declares: MCP-shaped, no implementing function (that stays in the page). */
export interface PageToolDescriptor {
  name: string;
  description: string;
  /** JSON Schema (draft 2020-12 object schema) for the tool's arguments. */
  inputSchema?: Record<string, unknown>;
}

/** A page's declaration of the full tool set for one namespace. */
export interface PageToolRegistration {
  /** Server-assigned id of the connection this namespace was declared on. */
  clientId: string;
  /** The page namespace (`morpho`, `aztec`, …); unique per connection. */
  ns: string;
  /** The page's live `location.href` at registration time. */
  url?: string;
  /** The browser tab the page lives in (correlation hints; see {@link TabInfo}). */
  tab?: TabInfo;
  /** Where the page's source lives on disk. */
  source?: SourceInfo;
  /** Content hash of the tool set (page-computed) — identity across reloads. */
  hash: string;
  /** The declared tools. */
  tools: PageToolDescriptor[];
  /** ISO timestamp of the (latest) registration. */
  registeredAt: string;
}

/** A call the agent asks the directory to route to a page. */
export interface PageToolCall {
  /** Disambiguator: which connection. Omit when the match is unique. */
  clientId?: string;
  /** Disambiguator: which namespace. Omit when the match is unique. */
  ns?: string;
  /** The tool to call. */
  name: string;
  /** Arguments (must satisfy the tool's `inputSchema`); passed through as-is. */
  args?: unknown;
  /** How long to wait for the page's result before rejecting (default 15s). */
  timeoutMs?: number;
}

/** A message the server sends down a page connection. */
export type ServerToClientMessage =
  | { v: 1; type: "call"; callId: string; ns: string; name: string; args?: unknown }
  | { v: 1; type: "registered"; ns: string; hash: string };

/** How the directory pushes a message to one connection. */
export type PageToolSend = (message: ServerToClientMessage) => void;

/** A cheap count summary of the directory, for `/health`/`/debug`. */
export interface PageToolSummary {
  /** Open page connections. */
  clients: number;
  /** Registered (connection, namespace) pairs. */
  namespaces: number;
  /** Total declared tools across all namespaces. */
  tools: number;
}

export interface PageToolDirectoryOptions {
  /**
   * Where the change-log line goes (a namespace registering a *new* tool-set
   * hash — reloads with an unchanged set are silent). Defaults to stderr, since
   * stdout carries the MCP protocol. Inject a collector in tests.
   */
  log?: (line: string) => void;
  /** Clock for `registeredAt` — inject for deterministic tests. */
  now?: () => Date;
  /** Id generator for client ids and call ids — inject for deterministic tests. */
  newId?: () => string;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Connection {
  clientId: string;
  send: PageToolSend;
  /** The namespaces this connection has declared, keyed by ns. */
  registrations: Map<string, PageToolRegistration>;
  /** In-flight calls awaiting a `result`, keyed by callId. */
  pending: Map<string, Pending>;
}

const DEFAULT_TIMEOUT_MS = 15_000;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;

/** A short, agent-readable identifier for a candidate registration. */
const describeCandidate = (reg: PageToolRegistration): string =>
  JSON.stringify({
    clientId: reg.clientId,
    ns: reg.ns,
    ...(reg.url ? { url: reg.url } : {}),
    ...(reg.tab?.title ? { tab: reg.tab.title } : {}),
  });

/**
 * The channel's live registry of page-declared tools and the connections that
 * back them. One instance per channel process; shared by the `/tools`
 * websocket (which feeds it) and the MCP tools (which read and drive it).
 */
export class PageToolDirectory {
  private readonly connections = new Map<string, Connection>();
  private readonly log: (line: string) => void;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(options: PageToolDirectoryOptions = {}) {
    this.log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
  }

  /** Register a freshly connected page socket; returns its server-assigned id. */
  addConnection(send: PageToolSend): string {
    const clientId = this.newId();
    this.connections.set(clientId, {
      clientId,
      send,
      registrations: new Map(),
      pending: new Map(),
    });
    return clientId;
  }

  /**
   * Drop a connection: forget its namespaces and reject any in-flight calls.
   * Called when the socket closes.
   */
  removeConnection(clientId: string): void {
    const conn = this.connections.get(clientId);
    if (!conn) {
      return;
    }
    for (const pending of conn.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("page disconnected before the tool call returned"));
    }
    this.connections.delete(clientId);
  }

  /**
   * Dispatch one parsed client message (a `register` or a `result`). Validates
   * loosely — a malformed message is ignored rather than fatal, since the
   * transport is a cooperative same-host client.
   */
  handleClientMessage(clientId: string, raw: unknown): void {
    const msg = asRecord(raw);
    if (!msg) {
      return;
    }
    if (msg.type === "register") {
      this.register(clientId, msg);
    } else if (msg.type === "result" && typeof msg.callId === "string") {
      this.settle(clientId, msg.callId, msg);
    }
  }

  private register(clientId: string, msg: Record<string, unknown>): void {
    const conn = this.connections.get(clientId);
    if (!conn || typeof msg.ns !== "string" || !Array.isArray(msg.tools)) {
      return;
    }
    const tools: PageToolDescriptor[] = msg.tools
      .map(asRecord)
      .filter((t): t is Record<string, unknown> => !!t && typeof t.name === "string")
      .map((t) => ({
        name: t.name as string,
        description: typeof t.description === "string" ? t.description : "",
        ...(asRecord(t.inputSchema) ? { inputSchema: asRecord(t.inputSchema) } : {}),
      }));
    const hash = typeof msg.hash === "string" ? msg.hash : "";
    const previous = conn.registrations.get(msg.ns);
    const entry: PageToolRegistration = {
      clientId,
      ns: msg.ns,
      ...(typeof msg.url === "string" ? { url: msg.url } : {}),
      ...(asRecord(msg.tab) ? { tab: asRecord(msg.tab) as TabInfo } : {}),
      ...(asRecord(msg.source) ? { source: asRecord(msg.source) as SourceInfo } : {}),
      hash,
      tools,
      registeredAt: this.now().toISOString(),
    };
    conn.registrations.set(msg.ns, entry);
    // Only a real change to the tool set is worth a line — HMR/reload
    // re-registrations carry the same hash and stay silent.
    if (!previous || previous.hash !== hash) {
      this.log(
        `page-tools: ${msg.ns} declared ${tools.length} tool(s) [${hash}]` +
          (entry.url ? ` from ${entry.url}` : ""),
      );
    }
    conn.send({ v: 1, type: "registered", ns: msg.ns, hash });
  }

  private settle(clientId: string, callId: string, msg: Record<string, unknown>): void {
    const conn = this.connections.get(clientId);
    const pending = conn?.pending.get(callId);
    if (!conn || !pending) {
      return;
    }
    conn.pending.delete(callId);
    clearTimeout(pending.timer);
    if (msg.ok === true) {
      pending.resolve(msg.value);
    } else {
      pending.reject(
        new Error(typeof msg.error === "string" ? msg.error : "page tool call failed"),
      );
    }
  }

  /** Every current registration, across all connections. */
  list(): PageToolRegistration[] {
    const out: PageToolRegistration[] = [];
    for (const conn of this.connections.values()) {
      for (const reg of conn.registrations.values()) {
        out.push(reg);
      }
    }
    return out;
  }

  /** Cheap counts for a `/health` or `/debug` summary. */
  summary(): PageToolSummary {
    let namespaces = 0;
    let tools = 0;
    for (const conn of this.connections.values()) {
      for (const reg of conn.registrations.values()) {
        namespaces += 1;
        tools += reg.tools.length;
      }
    }
    return { clients: this.connections.size, namespaces, tools };
  }

  /**
   * Route a call to the one page registration that matches. `clientId`/`ns`
   * narrow the search; either may be omitted when the match is already unique.
   * Rejects on ambiguity (listing the candidates), when nothing matches, on
   * timeout, or if the page disconnects before answering.
   */
  call(request: PageToolCall): Promise<unknown> {
    const { clientId, ns, name, args, timeoutMs = DEFAULT_TIMEOUT_MS } = request;
    const candidates: Array<{ conn: Connection; reg: PageToolRegistration }> = [];
    for (const conn of this.connections.values()) {
      if (clientId !== undefined && conn.clientId !== clientId) {
        continue;
      }
      for (const reg of conn.registrations.values()) {
        if (ns !== undefined && reg.ns !== ns) {
          continue;
        }
        if (reg.tools.some((t) => t.name === name)) {
          candidates.push({ conn, reg });
        }
      }
    }

    if (candidates.length === 0) {
      if (this.connections.size === 0) {
        return Promise.reject(new Error(`no page connected — cannot call tool "${name}"`));
      }
      const known = this.list()
        .flatMap((reg) => reg.tools.map((t) => `${reg.ns}/${t.name}`))
        .join(", ");
      return Promise.reject(
        new Error(
          `no page tool "${name}"${ns !== undefined ? ` in namespace "${ns}"` : ""} is registered` +
            (known ? ` (available: ${known})` : ""),
        ),
      );
    }
    if (candidates.length > 1) {
      const list = candidates.map((c) => describeCandidate(c.reg)).join(", ");
      return Promise.reject(
        new Error(
          `ambiguous tool "${name}" — ${candidates.length} registrations match; ` +
            `narrow with clientId and/or ns. Candidates: ${list}`,
        ),
      );
    }

    const { conn, reg } = candidates[0];
    const callId = this.newId();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(callId);
        reject(new Error(`page tool "${reg.ns}/${name}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      // Don't let a pending call keep the process alive on its own.
      if (typeof timer === "object" && "unref" in timer) {
        timer.unref();
      }
      conn.pending.set(callId, { resolve, reject, timer });
      try {
        conn.send({
          v: 1,
          type: "call",
          callId,
          ns: reg.ns,
          name,
          ...(args !== undefined ? { args } : {}),
        });
      } catch (err) {
        clearTimeout(timer);
        conn.pending.delete(callId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }
}
