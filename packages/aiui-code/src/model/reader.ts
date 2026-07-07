/**
 * reader.ts — the durable Monaco island + its "remote control".
 *
 * Everything here is created ONCE and adopted across HMR (store.ts wraps it in
 * `durable`): the Monaco editor, its text models, view state, the LSP clients,
 * and the navigation history. The SolidJS chrome around it is disposable; it
 * talks to the island only through this small, declarative surface — commands in
 * (openFile/reveal/goto), coarse signals out (currentFile/selection/cursor/
 * lspStatus/diagnostics/servers). Monaco's per-keystroke state never leaves it.
 *
 * Multi-language: the reader learns the project's configured servers from the
 * backend's manifest (`/lsp/servers`) and holds **one LSP client per language**,
 * connected lazily when a file of that language is first opened. A `.py` file
 * routes to pyright, a `.ts` file to typescript-language-server — one Monaco,
 * one set of providers, N clients.
 */

import {
  type BackendInfo,
  type FileReadResponse,
  type LspServersResponse,
  lspSocketUrl,
  ROUTES,
} from "@habemus-papadum/aiui-code-protocol";
import { type Accessor, createSignal } from "solid-js";
import type { Diagnostic, Location } from "vscode-languageserver-protocol";
import { LspClient, type LspClient as LspClientType } from "../lsp/client";
import {
  applyDiagnostics,
  registerLspProviders,
  toLspRange,
  toMonacoRange,
} from "../lsp/lsp-monaco";
import { monaco } from "../monaco/monaco";
import { backendOrigin, backendUrl } from "./backend-origin";
import type { LspRange, NavEntry, ReaderServer, SelectionSnapshot } from "./types";

interface ManagedServer {
  language: string;
  languageId: string;
  name?: string;
  extensions: string[];
  verified?: boolean;
  initializationOptions?: Record<string, unknown>;
}

export interface CodeReader {
  /** The durable DOM node Monaco lives in; a component adopts it via a ref. */
  readonly container: HTMLElement;
  readonly editor: monaco.editor.IStandaloneCodeEditor;
  /** Resolves once /info + /lsp/servers are loaded and providers are registered. */
  readonly ready: Promise<void>;

  // --- coarse observables out ---
  readonly currentFile: Accessor<string | undefined>;
  readonly currentLanguageId: Accessor<string | undefined>;
  readonly openFiles: Accessor<string[]>;
  readonly selection: Accessor<SelectionSnapshot | undefined>;
  readonly cursor: Accessor<{ line: number; character: number } | undefined>;
  /** LSP status of the current file's language server (or "—" if unmanaged). */
  readonly lspStatus: Accessor<string>;
  /** Every configured server + its live connection status (for the LSP panel). */
  readonly servers: Accessor<ReaderServer[]>;
  /** Bumps whenever diagnostics change — cells that summarize them depend on it. */
  readonly diagnosticsVersion: Accessor<number>;
  /** Bumps whenever the nav stack changes. */
  readonly navVersion: Accessor<number>;
  readonly root: Accessor<string | undefined>;

  // --- commands in ---
  attach(host: HTMLElement): void;
  openFile(file: string, opts?: { range?: LspRange; pushHistory?: boolean }): Promise<void>;
  /** Open by file URI (what LSP results carry) — resolves to a project path. */
  openUri(uri: string, range?: LspRange): Promise<void>;
  reveal(range: LspRange): void;
  gotoDefinition(): Promise<Location[]>;
  findReferences(): Promise<Location[]>;
  back(): boolean;
  forward(): boolean;
  canBack(): boolean;
  canForward(): boolean;
  setColorMode(mode: "light" | "dark"): void;
  /** Current file's diagnostics (for the status bar / agent report). */
  diagnosticsFor(file: string): monaco.editor.IMarkerData[];
  documentSymbols(file: string): ReturnType<LspClientType["documentSymbols"]>;
  workspaceSymbols(query: string): ReturnType<LspClientType["workspaceSymbols"]>;
  /** The LSP client for the current file's language, if any. */
  client(): LspClientType | undefined;
}

export function createReader(): CodeReader {
  const container = document.createElement("div");
  container.className = "reader-monaco";
  container.style.width = "100%";
  container.style.height = "100%";

  const editor = monaco.editor.create(container, {
    readOnly: true,
    domReadOnly: true,
    // Monaco's own ResizeObserver keeps the editor sized to its (durable,
    // later-adopted) container; attach() adds a couple of rAF/timeout nudges so
    // the first paint isn't delayed until the observer's first delivery.
    automaticLayout: true,
    theme: initialColorMode() === "dark" ? "vs-dark" : "vs",
    // Off by default: the minimap's continuous canvas rendering starves the
    // compositor and hangs Chrome-DevTools-MCP screenshots — and screenshotting
    // the live UI through that MCP is the core aiui workflow (CLAUDE.md).
    minimap: { enabled: false },
    folding: true,
    showFoldingControls: "always",
    glyphMargin: true,
    scrollBeyondLastLine: false,
    renderWhitespace: "selection",
    fontSize: 13,
    lineNumbersMinChars: 3,
    fixedOverflowWidgets: true,
    smoothScrolling: true,
  });

  const [currentFile, setCurrentFile] = createSignal<string | undefined>(undefined);
  const [currentLanguageId, setCurrentLanguageId] = createSignal<string | undefined>(undefined);
  const [openFiles, setOpenFiles] = createSignal<string[]>([]);
  const [selection, setSelection] = createSignal<SelectionSnapshot | undefined>(undefined);
  const [cursor, setCursor] = createSignal<{ line: number; character: number } | undefined>(
    undefined,
  );
  const [diagnosticsVersion, bumpDiagnostics] = counter();
  const [navVersion, bumpNav] = counter();
  const [serversVersion, bumpServers] = counter();
  const [root, setRoot] = createSignal<string | undefined>(undefined);

  const models = new Map<string, monaco.editor.ITextModel>();
  const openDocs = new Set<string>(); // uris we've sent didOpen for
  const diagnostics = new Map<string, monaco.editor.IMarkerData[]>();
  const back: NavEntry[] = [];
  const forward: NavEntry[] = [];

  // Multi-language: the configured servers + one client per language.
  const managed = new Map<string, ManagedServer>(); // languageId → server
  const clients = new Map<string, LspClient>();
  const statusByLang = new Map<string, string>();
  let rootAbs: string | undefined;
  let modelVersion = 0;

  // --- uri <-> relative-path plumbing ---------------------------------------
  const fileUri = (rel: string): string =>
    monaco.Uri.file(`${rootAbs}/${rel}`.replace(/\/+/g, "/")).toString();
  const relFromUri = (uri: string): string => {
    const fsPath = monaco.Uri.parse(uri).fsPath;
    if (rootAbs && fsPath.startsWith(rootAbs)) {
      return fsPath.slice(rootAbs.length).replace(/^\/+/, "");
    }
    return fsPath;
  };

  // --- one LSP client per language, connected lazily ------------------------
  function clientForLanguage(languageId: string): LspClient | undefined {
    if (!managed.has(languageId)) return undefined;
    const existing = clients.get(languageId);
    if (existing) return existing;
    const info = managed.get(languageId) as ManagedServer;
    const client = new LspClient(
      lspSocketUrl(backendOrigin(), languageId),
      monaco.Uri.file(rootAbs ?? "/").toString(),
      info.initializationOptions,
    );
    clients.set(languageId, client);

    // didOpen any of this language's models the server hasn't seen — after the
    // first handshake AND after every reconnect (a fresh server has no state).
    const openModels = () => {
      for (const [uri, model] of models) {
        if (model.getLanguageId() === languageId && !openDocs.has(uri)) {
          openDocs.add(uri);
          client.didOpen(uri, languageId, ++modelVersion, model.getValue());
        }
      }
    };

    // Redial on close: the channel restarts on `channel_reload`, and a dropped
    // socket must not permanently kill navigation until a page reload. Probe the
    // backend cheaply first (console hygiene — never dial a websocket blind),
    // then re-run the handshake, with capped backoff while the backend is away.
    let redialTimer: ReturnType<typeof setTimeout> | undefined;
    let redialDelay = 1_000;
    const scheduleRedial = () => {
      if (redialTimer !== undefined) return;
      redialTimer = setTimeout(() => {
        redialTimer = undefined;
        void redial();
      }, redialDelay);
    };
    const redial = async () => {
      try {
        const res = await fetch(backendUrl(ROUTES.info));
        if (!res.ok) throw new Error(`backend answered ${res.status}`);
        await client.start();
        redialDelay = 1_000;
        openModels();
      } catch {
        redialDelay = Math.min(redialDelay * 2, 30_000);
        scheduleRedial();
      }
    };

    client.onStatus((s) => {
      statusByLang.set(languageId, s);
      bumpServers();
      if (s === "closed") {
        // The fresh server won't know these documents — forget the didOpens so
        // the reconnect replays them.
        for (const [uri, model] of models) {
          if (model.getLanguageId() === languageId) openDocs.delete(uri);
        }
        scheduleRedial();
      }
    });
    client.onNotification("textDocument/publishDiagnostics", (params) => {
      const { uri, diagnostics: diags } = params as { uri: string; diagnostics: Diagnostic[] };
      diagnostics.set(uri, applyDiagnostics(monaco, uri, diags));
      bumpDiagnostics();
    });
    client
      .start()
      .then(openModels)
      .catch((err) => {
        statusByLang.set(languageId, "error");
        bumpServers();
        console.error(`[aiui-code] LSP(${languageId}) failed to start:`, err);
        scheduleRedial();
      });
    return client;
  }

  // --- coarse events out of Monaco ------------------------------------------
  editor.onDidChangeCursorPosition((e) => {
    setCursor({ line: e.position.lineNumber - 1, character: e.position.column - 1 });
  });
  editor.onDidChangeCursorSelection((e) => {
    const model = editor.getModel();
    const file = currentFile();
    if (!model || !file) return;
    setSelection({
      file,
      range: toLspRange(e.selection),
      text: model.getValueInRange(e.selection),
    });
  });

  // --- fetch a file's text from the backend ---------------------------------
  async function fetchFile(rel: string): Promise<FileReadResponse> {
    const res = await fetch(backendUrl(`${ROUTES.read}?path=${encodeURIComponent(rel)}`));
    if (!res.ok) throw new Error(`read ${rel}: ${res.status}`);
    return (await res.json()) as FileReadResponse;
  }

  async function ensureModel(uri: string): Promise<monaco.editor.ITextModel> {
    const existing = models.get(uri);
    if (existing) return existing;
    const rel = relFromUri(uri);
    const { content, languageId } = await fetchFile(rel);
    const raced = models.get(uri);
    if (raced) return raced;
    const model = monaco.editor.createModel(content, languageId, monaco.Uri.parse(uri));
    models.set(uri, model);
    // If this language has a server, ensure its client and didOpen when ready.
    const client = clientForLanguage(languageId);
    if (client && client.status === "ready" && !openDocs.has(uri)) {
      openDocs.add(uri);
      client.didOpen(uri, languageId, ++modelVersion, content);
    }
    const cached = diagnostics.get(uri);
    if (cached) monaco.editor.setModelMarkers(model, "lsp", cached);
    return model;
  }

  function currentPositionEntry(): NavEntry | undefined {
    const file = currentFile();
    const pos = editor.getPosition();
    if (!file || !pos) return undefined;
    return { file, line: pos.lineNumber - 1, character: pos.column - 1 };
  }

  async function openFile(
    file: string,
    opts: { range?: LspRange; pushHistory?: boolean } = {},
  ): Promise<void> {
    await ready;
    const { range, pushHistory = true } = opts;
    if (pushHistory) {
      const here = currentPositionEntry();
      if (here && here.file !== file) {
        back.push(here);
        forward.length = 0;
        bumpNav();
      }
    }
    const uri = fileUri(file);
    const model = await ensureModel(uri);
    editor.setModel(model);
    setCurrentFile(file);
    setCurrentLanguageId(model.getLanguageId());
    setOpenFiles((prev) => (prev.includes(file) ? prev : [...prev, file]));
    if (range) reveal(range);
    else editor.revealLine(1);
    // setModel doesn't change layout, so automaticLayout's observer won't repaint
    // — force a synchronous redraw so the new file's lines render promptly.
    editor.render(true);
  }

  function reveal(range: LspRange): void {
    const mr = toMonacoRange(range);
    editor.revealRangeInCenterIfOutsideViewport(mr, monaco.editor.ScrollType.Smooth);
    editor.setSelection(mr);
    editor.setPosition({ lineNumber: mr.startLineNumber, column: mr.startColumn });
    editor.focus();
  }

  async function openUri(uri: string, range?: LspRange): Promise<void> {
    await openFile(relFromUri(uri), range ? { range } : {});
  }

  /** The client owning the active editor model's language. */
  function activeClient(): LspClient | undefined {
    const model = editor.getModel();
    return model ? clientForLanguage(model.getLanguageId()) : undefined;
  }

  async function gotoDefinition(): Promise<Location[]> {
    const model = editor.getModel();
    const pos = editor.getPosition();
    const client = activeClient();
    if (!client || !model || !pos) return [];
    const locs = await client.definition(model.uri.toString(), {
      line: pos.lineNumber - 1,
      character: pos.column - 1,
    });
    if (locs[0]) await openUri(locs[0].uri, locs[0].range);
    return locs;
  }

  async function findReferences(): Promise<Location[]> {
    const model = editor.getModel();
    const pos = editor.getPosition();
    const client = activeClient();
    if (!client || !model || !pos) return [];
    return client.references(model.uri.toString(), {
      line: pos.lineNumber - 1,
      character: pos.column - 1,
    });
  }

  function navTo(entry: NavEntry): void {
    void openFile(entry.file, {
      pushHistory: false,
      range: {
        start: { line: entry.line, character: entry.character },
        end: { line: entry.line, character: entry.character },
      },
    });
  }

  // --- init: discover the project + its servers, register providers ----------
  const ready = (async () => {
    let info: BackendInfo;
    try {
      const res = await fetch(backendUrl(ROUTES.info));
      if (!res.ok) throw new Error(`info ${res.status}`);
      info = (await res.json()) as BackendInfo;
    } catch (err) {
      console.error("[aiui-code] backend /info unavailable:", err);
      return;
    }
    rootAbs = info.root.replace(/\/+$/, "");
    setRoot(rootAbs);

    // Learn the configured servers (may be empty — reader still reads files).
    try {
      const res = await fetch(backendUrl(ROUTES.lspServers));
      if (res.ok) {
        const body = (await res.json()) as LspServersResponse;
        for (const s of body.servers) {
          managed.set(s.languageId, {
            language: s.language,
            languageId: s.languageId,
            ...(s.name ? { name: s.name } : {}),
            extensions: s.extensions,
            ...(s.verified !== undefined ? { verified: s.verified } : {}),
            ...(s.initializationOptions ? { initializationOptions: s.initializationOptions } : {}),
          });
          statusByLang.set(s.languageId, "idle");
        }
      }
    } catch (err) {
      console.error("[aiui-code] /lsp/servers unavailable:", err);
    }
    bumpServers();

    // One provider registration serves every managed language; each resolves its
    // client by the document's language id.
    registerLspProviders(
      monaco,
      (langId) => clientForLanguage(langId),
      {
        ensureModel: async (u) => void (await ensureModel(u)),
        openUri,
      },
      [...managed.keys()],
    );
  })();

  const lspStatus = (): string => {
    serversVersion();
    const lang = currentLanguageId();
    if (!lang) return "—";
    if (!managed.has(lang)) return "none";
    return statusByLang.get(lang) ?? "idle";
  };

  const servers = (): ReaderServer[] => {
    serversVersion();
    return [...managed.values()].map((s) => ({
      language: s.language,
      languageId: s.languageId,
      ...(s.name ? { name: s.name } : {}),
      extensions: s.extensions,
      ...(s.verified !== undefined ? { verified: s.verified } : {}),
      status: statusByLang.get(s.languageId) ?? "idle",
    }));
  };

  return {
    container,
    editor,
    ready,
    currentFile,
    currentLanguageId,
    openFiles,
    selection,
    cursor,
    lspStatus,
    servers,
    diagnosticsVersion,
    navVersion,
    root,
    attach(host: HTMLElement) {
      if (container.parentElement !== host) host.appendChild(container);
      // Nudge a measure once the CSS grid has resolved the pane height, so we
      // don't wait for automaticLayout's first observer delivery. Idempotent.
      requestAnimationFrame(() => editor.layout());
      setTimeout(() => editor.layout(), 60);
    },
    openFile,
    openUri,
    reveal,
    gotoDefinition,
    findReferences,
    back() {
      const entry = back.pop();
      if (!entry) return false;
      const here = currentPositionEntry();
      if (here) forward.push(here);
      bumpNav();
      navTo(entry);
      return true;
    },
    forward() {
      const entry = forward.pop();
      if (!entry) return false;
      const here = currentPositionEntry();
      if (here) back.push(here);
      bumpNav();
      navTo(entry);
      return true;
    },
    canBack: () => {
      navVersion(); // subscribe: recompute when the nav stack changes
      return back.length > 0;
    },
    canForward: () => {
      navVersion();
      return forward.length > 0;
    },
    setColorMode(mode) {
      monaco.editor.setTheme(mode === "dark" ? "vs-dark" : "vs");
    },
    diagnosticsFor(file) {
      return diagnostics.get(fileUri(file)) ?? [];
    },
    documentSymbols(file) {
      const model = models.get(fileUri(file));
      const client = model ? clientForLanguage(model.getLanguageId()) : undefined;
      if (!client) return Promise.resolve(null);
      return client.documentSymbols(fileUri(file));
    },
    workspaceSymbols(query) {
      const client = activeClient();
      if (!client) return Promise.resolve([]);
      return client.workspaceSymbols(query);
    },
    client: activeClient,
  };
}

function counter(): [Accessor<number>, () => void] {
  const [get, set] = createSignal(0);
  return [get, () => set((n) => n + 1)];
}

function initialColorMode(): "light" | "dark" {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}
