/**
 * client.ts — a real LSP client in the browser.
 *
 * The proposal's load-bearing constraint (§"No veneer"): the browser talks
 * genuine LSP JSON-RPC to a real language server; the channel must not dumb it
 * down. The `/lsp` websocket is a byte relay — the backend reframes the server's
 * `Content-Length`-framed JSON-RPC into one JSON message per text frame and back
 * (see src/server/lsp-proxy.ts), and NOTHING in the middle understands or
 * rewrites LSP semantics. This module is the client end of that pipe: it issues
 * `initialize`, `textDocument/definition`, `.../references`, `.../hover`,
 * `.../documentSymbol`, `.../foldingRange`, `workspace/symbol`, and consumes real
 * `publishDiagnostics`.
 *
 * It is deliberately small — a JSON-RPC 2.0 request/response/notification loop —
 * rather than the full `monaco-languageclient` + `@codingame/monaco-vscode-api`
 * stack. That stack is the turnkey path the proposal names, but it pulls in the
 * whole VS Code service layer; for a focused read-only surface a direct client is
 * more legible and more debuggable, and it satisfies the constraint that matters:
 * undiluted LSP on the wire. (See README for this deviation.)
 */
import type {
  Diagnostic,
  DocumentSymbol,
  FoldingRange,
  Hover,
  InitializeResult,
  Location,
  LocationLink,
  Position,
  Range,
  SymbolInformation,
  WorkspaceSymbol,
} from "vscode-languageserver-protocol";

type Json = Record<string, unknown>;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export type LspStatus = "connecting" | "initializing" | "ready" | "closed" | "error";

export interface DiagnosticsEvent {
  uri: string;
  diagnostics: Diagnostic[];
}

/**
 * A minimal JSON-RPC 2.0 client over a WebSocket carrying one LSP message per
 * text frame. Reconnects are the caller's concern (the durable store owns the
 * lifetime); this object is created once and adopted across HMR.
 */
export class LspClient {
  private ws: WebSocket | undefined;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly notify = new Map<string, Set<(params: unknown) => void>>();
  private readonly statusListeners = new Set<(s: LspStatus) => void>();
  private _status: LspStatus = "connecting";
  private _capabilities: InitializeResult["capabilities"] | undefined;
  private queue: string[] = []; // frames buffered until the socket opens

  constructor(
    private readonly url: string,
    private readonly rootUri: string,
    /** `initializationOptions` for the `initialize` request (e.g. tsserver path). */
    private readonly initializationOptions?: Record<string, unknown>,
  ) {}

  get status(): LspStatus {
    return this._status;
  }
  get capabilities(): InitializeResult["capabilities"] | undefined {
    return this._capabilities;
  }

  onStatus(cb: (s: LspStatus) => void): () => void {
    this.statusListeners.add(cb);
    cb(this._status);
    return () => this.statusListeners.delete(cb);
  }

  private setStatus(s: LspStatus): void {
    this._status = s;
    for (const cb of this.statusListeners) cb(s);
  }

  /** Subscribe to a server→client notification (e.g. `textDocument/publishDiagnostics`). */
  onNotification(method: string, cb: (params: unknown) => void): () => void {
    let set = this.notify.get(method);
    if (!set) {
      set = new Set();
      this.notify.set(method, set);
    }
    set.add(cb);
    return () => set?.delete(cb);
  }

  /** Connect and run the `initialize`/`initialized` handshake. Idempotent-ish:
   * a second call after a close reconnects (the reader does this — see the
   * redial wiring in model/reader.ts). */
  async start(): Promise<InitializeResult> {
    this.setStatus("connecting");
    await this.open();
    this.setStatus("initializing");
    const result = (await this.request("initialize", {
      processId: null,
      clientInfo: { name: "aiui-code-reader" },
      rootUri: this.rootUri,
      workspaceFolders: [{ uri: this.rootUri, name: "workspace" }],
      capabilities: clientCapabilities(),
      ...(this.initializationOptions ? { initializationOptions: this.initializationOptions } : {}),
    })) as InitializeResult;
    this._capabilities = result.capabilities;
    this.sendNotification("initialized", {});
    // Flush frames queued while connecting only NOW: the spec forbids other
    // requests until the server has answered `initialize`.
    const queued = this.queue;
    this.queue = [];
    for (const frame of queued) this.ws?.send(frame);
    this.setStatus("ready");
    return result;
  }

  private open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("message", (ev) => this.onFrame(String(ev.data)));
      ws.addEventListener("error", () => {
        // Only a handshake failure is an ERROR state; a benign error event on an
        // open socket is followed by `close`, which reports (and recovers) as
        // "closed" — it must not latch the status chip red forever.
        if (this._status === "connecting") {
          reject(new Error("lsp websocket failed to open"));
          this.setStatus("error");
        }
      });
      ws.addEventListener("close", () => {
        this.setStatus("closed");
        for (const p of this.pending.values()) p.reject(new Error("lsp connection closed"));
        this.pending.clear();
        // Queued frames belong to the dead connection (their pending entries
        // were just rejected); a reconnect re-opens documents itself.
        this.queue = [];
      });
    });
  }

  private onFrame(data: string): void {
    let msg: Json;
    try {
      msg = JSON.parse(data) as Json;
    } catch {
      return; // a cooperative same-host relay shouldn't send garbage
    }
    if (typeof msg.id === "number" && ("result" in msg || "error" in msg)) {
      // A response to one of our requests.
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        const err = msg.error as { message?: string; code?: number };
        pending.reject(new Error(err.message ?? `lsp error ${err.code ?? ""}`));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
    if (typeof msg.method === "string" && "id" in msg) {
      // A server→client REQUEST — must be answered or the server may stall.
      this.answerServerRequest(msg);
      return;
    }
    if (typeof msg.method === "string") {
      // A notification.
      const set = this.notify.get(msg.method);
      if (set) for (const cb of set) cb(msg.params);
    }
  }

  /**
   * Answer the server→client requests pyright makes during startup. We keep the
   * client thin: `workspace/configuration` gets an empty settings object per
   * item; everything else that expects a response gets `null`. That is enough
   * for a read-only client — we register no dynamic capabilities of our own to
   * revoke, and want default analysis settings.
   */
  private answerServerRequest(msg: Json): void {
    const id = msg.id;
    const method = msg.method as string;
    let result: unknown = null;
    if (method === "workspace/configuration") {
      const items = (msg.params as { items?: unknown[] })?.items ?? [];
      result = items.map(() => ({}));
    }
    this.sendRaw({ jsonrpc: "2.0", id, result });
  }

  private sendRaw(msg: Json): void {
    const frame = JSON.stringify(msg);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(frame);
    else this.queue.push(frame);
  }

  /** Issue a request and await its result. */
  request(method: string, params?: unknown): Promise<unknown> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.sendRaw({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** Fire a notification (no response). */
  sendNotification(method: string, params?: unknown): void {
    this.sendRaw({ jsonrpc: "2.0", method, params });
  }

  close(): void {
    try {
      this.ws?.close();
    } catch {
      // already closing
    }
  }

  // --- typed convenience wrappers over the raw requests ---------------------

  didOpen(uri: string, languageId: string, version: number, text: string): void {
    this.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId, version, text },
    });
  }
  didClose(uri: string): void {
    this.sendNotification("textDocument/didClose", { textDocument: { uri } });
  }
  didChangeWatchedFiles(changes: Array<{ uri: string; type: 1 | 2 | 3 }>): void {
    this.sendNotification("workspace/didChangeWatchedFiles", { changes });
  }

  async definition(uri: string, position: Position): Promise<Location[]> {
    const res = await this.request("textDocument/definition", {
      textDocument: { uri },
      position,
    });
    return normalizeLocations(res);
  }
  async references(
    uri: string,
    position: Position,
    includeDeclaration = true,
  ): Promise<Location[]> {
    const res = await this.request("textDocument/references", {
      textDocument: { uri },
      position,
      context: { includeDeclaration },
    });
    return normalizeLocations(res);
  }
  hover(uri: string, position: Position): Promise<Hover | null> {
    return this.request("textDocument/hover", {
      textDocument: { uri },
      position,
    }) as Promise<Hover | null>;
  }
  documentSymbols(uri: string): Promise<DocumentSymbol[] | SymbolInformation[] | null> {
    return this.request("textDocument/documentSymbol", { textDocument: { uri } }) as Promise<
      DocumentSymbol[] | SymbolInformation[] | null
    >;
  }
  foldingRanges(uri: string): Promise<FoldingRange[] | null> {
    return this.request("textDocument/foldingRange", { textDocument: { uri } }) as Promise<
      FoldingRange[] | null
    >;
  }
  workspaceSymbols(query: string): Promise<Array<SymbolInformation | WorkspaceSymbol>> {
    return this.request("workspace/symbol", { query }) as Promise<
      Array<SymbolInformation | WorkspaceSymbol>
    >;
  }
}

/** Definition/references come back as Location, Location[], or LocationLink[]. */
function normalizeLocations(res: unknown): Location[] {
  if (!res) return [];
  const arr = Array.isArray(res) ? res : [res];
  return arr.map((item) => {
    const link = item as LocationLink;
    if (link.targetUri && link.targetRange) {
      return { uri: link.targetUri, range: link.targetSelectionRange ?? link.targetRange };
    }
    return item as Location;
  });
}

/** The capabilities a read-only reader advertises — enough to get real results
 * for the features we surface, nothing we can't honor. */
function clientCapabilities(): Json {
  const markdownPlainText = { contentFormat: ["markdown", "plaintext"] };
  return {
    textDocument: {
      synchronization: { dynamicRegistration: false, didSave: false },
      hover: { ...markdownPlainText, dynamicRegistration: false },
      definition: { dynamicRegistration: false, linkSupport: true },
      references: { dynamicRegistration: false },
      documentSymbol: {
        dynamicRegistration: false,
        hierarchicalDocumentSymbolSupport: true,
      },
      foldingRange: { dynamicRegistration: false, lineFoldingOnly: true },
      publishDiagnostics: { relatedInformation: true },
      completion: { dynamicRegistration: false },
    },
    workspace: {
      symbol: { dynamicRegistration: false },
      configuration: true,
      workspaceFolders: true,
      didChangeWatchedFiles: { dynamicRegistration: false },
    },
  };
}

export type { Diagnostic, DocumentSymbol, FoldingRange, Location, Position, Range };
