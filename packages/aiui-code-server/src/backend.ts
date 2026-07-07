/**
 * backend.ts — the reader's cwd-bound services, mounted transport-agnostically.
 *
 * {@link mountAiuiCodeBackend} returns a handle with two host-neutral seams — an
 * HTTP request handler and a websocket-upgrade handler — so the identical code
 * mounts on the Vite dev server today (see vite-plugin.ts) and, later, on the
 * channel's own http/ws server without a rename. It handles only its own routes
 * (everything under {@link AIUI_CODE_PREFIX} + the `/lsp` upgrade) and hands
 * everything else back to the host untouched — critically, it never destroys a
 * non-matching upgrade socket, so it coexists with Vite's HMR websocket.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type {
  BackendInfo,
  FileTreeResponse,
  LspServersResponse,
  Walkthrough,
  WalkthroughListResponse,
} from "@habemus-papadum/aiui-code-protocol";
import { AIUI_CODE_PREFIX, ROUTES } from "@habemus-papadum/aiui-code-protocol";
import {
  createLspProxy,
  ensureDefaultManifest,
  type LspManifest,
  type LspProxy,
  type LspServerEntry,
  type LspSocket,
  languageIdForPath,
  launcherPath,
  serverForLanguageId,
} from "@habemus-papadum/aiui-lsp";
import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";
import { createFileService } from "./files";
import { monacoLanguageId } from "./language-id";
import { createWalkthroughStore } from "./walkthrough-store";

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Parse a request-target, or undefined for a malformed one (e.g. `//[`) — a
 * request we can't even parse is never ours, and it must not throw: the host
 * calls these handlers on every request, and an exception here would surface as
 * an unhandled rejection (or crash the upgrade path) in the host process. */
const parseRequestUrl = (raw: string | undefined): URL | undefined => {
  try {
    return new URL(raw ?? "/", "http://localhost");
  } catch {
    return undefined;
  }
};

/** Cap on a POST body (walkthroughs are small JSON documents). */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface AiuiCodeBackendDeps {
  /** Project root served + LSP cwd. */
  root: string;
  /** Walkthrough cache dir; defaults to `${root}/.aiui-cache`. */
  cacheDir?: string;
  /** Line logger for lifecycle/errors. */
  onLog?: (line: string) => void;
}

export interface MountedBackend {
  /** Handle an HTTP request for an `/__aiui_code/*` route. Returns true if handled. */
  handleHttp(req: IncomingMessage, res: ServerResponse): boolean | Promise<boolean>;
  /** Handle a websocket upgrade for the `/lsp` route. Returns true if it claimed it. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  dispose(): void;
}

/** Adapt a real `ws` socket to the relay's minimal {@link LspSocket}. */
function adaptWs(ws: WebSocket): LspSocket {
  return {
    send: (data) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(data);
      }
    },
    onMessage: (cb) => {
      ws.on("message", (data, isBinary) => {
        // LSP travels as text frames, one JSON-RPC message each; ignore binary.
        if (!isBinary) {
          cb(data.toString());
        }
      });
    },
    onClose: (cb) => {
      ws.on("close", () => cb());
    },
    close: () => {
      try {
        ws.close();
      } catch {
        // already closing
      }
    },
  };
}

export function mountAiuiCodeBackend(deps: AiuiCodeBackendDeps): MountedBackend {
  const log = deps.onLog ?? (() => {});
  const cacheDir = deps.cacheDir ?? `${deps.root}/.aiui-cache`;

  // The project's language servers: the committed .aiui/lsp setup when one
  // exists, else bootstrap one from the built-in recipes for whatever well-known
  // languages the project contains (python, typescript/js) — so the reader works
  // out of the box. The bootstrap lands in the gitignored .aiui-cache/lsp
  // (mounting the reader must never dirty the working tree); `aiui setup-lsp`
  // records the committed, hand-tuned setup that then takes precedence.
  const manifest: LspManifest = ensureDefaultManifest(deps.root, { onLog: log });
  for (const s of manifest.servers)
    log(`lsp: ${s.language} → ${s.languageId} (${s.name ?? s.launcher})`);

  // The model language id: prefer the manifest's LSP language id for managed
  // files, else the Monaco grammar fallback (markdown/json/…).
  const languageIdFor = (rel: string): string =>
    languageIdForPath(manifest, rel) ?? monacoLanguageId(rel);

  const files = createFileService({ root: deps.root, languageId: languageIdFor });
  const store = createWalkthroughStore({ dir: `${cacheDir}/walkthroughs`, log });

  // One relay manager per language, created lazily and reused. Each manager
  // still spawns a private child per attached socket (see aiui-lsp/proxy.ts).
  const proxies = new Map<string, LspProxy>();
  const proxyFor = (entry: LspServerEntry): LspProxy => {
    let proxy = proxies.get(entry.languageId);
    if (!proxy) {
      proxy = createLspProxy(
        { command: launcherPath(deps.root, entry), args: [], cwd: deps.root },
        { onLog: log, label: entry.language },
      );
      proxies.set(entry.languageId, proxy);
    }
    return proxy;
  };

  const wss = new WebSocketServer({ noServer: true });

  const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  };

  const readJsonBody = (req: IncomingMessage): Promise<unknown> =>
    new Promise((resolveBody, rejectBody) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          rejectBody(new Error("request body too large"));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        try {
          resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          rejectBody(new Error("invalid JSON body"));
        }
      });
      req.on("error", rejectBody);
    });

  const handleHttp = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = parseRequestUrl(req.url);
    if (!url) {
      return false; // an unparseable request-target is never ours
    }
    const pathname = url.pathname;
    if (!pathname.startsWith(AIUI_CODE_PREFIX)) {
      return false; // not ours — let the host route it
    }

    // Readable cross-origin: the reader may run on a different origin than the
    // channel later; the payload is harmless loopback metadata (mirrors the
    // `/health` comment in aiui-claude-channel's web.ts).
    res.setHeader("Access-Control-Allow-Origin", "*");
    const method = req.method ?? "GET";

    if (method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.statusCode = 204;
      res.end();
      return true;
    }

    try {
      if (pathname === ROUTES.info && method === "GET") {
        sendJson(res, 200, {
          ok: true,
          root: deps.root,
          languages: manifest.servers.map((s) => s.languageId),
        } satisfies BackendInfo);
        return true;
      }

      if (pathname === ROUTES.lspServers && method === "GET") {
        sendJson(res, 200, {
          servers: manifest.servers.map((s) => ({
            language: s.language,
            languageId: s.languageId,
            extensions: s.extensions,
            ...(s.name ? { name: s.name } : {}),
            ...(s.verified ? { verified: s.verified.ok } : {}),
            ...(s.initializationOptions ? { initializationOptions: s.initializationOptions } : {}),
          })),
        } satisfies LspServersResponse);
        return true;
      }

      if (pathname === ROUTES.tree && method === "GET") {
        const entries = await files.tree();
        sendJson(res, 200, { root: deps.root, entries } satisfies FileTreeResponse);
        return true;
      }

      if (pathname === ROUTES.read && method === "GET") {
        const rel = url.searchParams.get("path");
        if (!rel) {
          sendJson(res, 400, { ok: false, error: "missing ?path= query parameter" });
          return true;
        }
        try {
          sendJson(res, 200, await files.read(rel));
        } catch (err) {
          sendJson(res, 400, { ok: false, error: errMsg(err) });
        }
        return true;
      }

      if (pathname === ROUTES.walkthroughs) {
        if (method === "GET") {
          const walkthroughs = await store.list();
          sendJson(res, 200, { walkthroughs } satisfies WalkthroughListResponse);
          return true;
        }
        if (method === "POST") {
          try {
            const body = (await readJsonBody(req)) as Walkthrough;
            const saved = await store.save(body);
            sendJson(res, 200, saved);
          } catch (err) {
            sendJson(res, 400, { ok: false, error: errMsg(err) });
          }
          return true;
        }
      }

      if (pathname.startsWith(`${ROUTES.walkthroughs}/`) && method === "GET") {
        const id = decodeURIComponent(pathname.slice(`${ROUTES.walkthroughs}/`.length));
        const w = await store.get(id);
        if (!w) {
          sendJson(res, 404, { ok: false, error: `walkthrough not found: ${id}` });
          return true;
        }
        sendJson(res, 200, w);
        return true;
      }

      // Under our prefix but no route matched — it is still ours to answer.
      sendJson(res, 404, { ok: false, error: `no route: ${method} ${pathname}` });
      return true;
    } catch (err) {
      // Unexpected server-side failure (e.g. the tree walk blew up).
      sendJson(res, 500, { ok: false, error: errMsg(err) });
      return true;
    }
  };

  const handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): boolean => {
    const url = parseRequestUrl(req.url);
    if (!url || url.pathname !== ROUTES.lsp) {
      // Not ours — return WITHOUT destroying the socket, so the host's own
      // upgrade listener (Vite's HMR websocket) still gets it.
      return false;
    }
    const langId = url.searchParams.get("lang") ?? "";
    wss.handleUpgrade(req, socket, head, (ws) => {
      // A socket 'error' is followed by 'close'; swallow it so it can't crash
      // the process (Node treats an unhandled socket 'error' as fatal).
      ws.on("error", () => {});
      const entry = serverForLanguageId(manifest, langId);
      if (!entry) {
        log(`lsp: no language server configured for "${langId}"`);
        try {
          ws.close(1008, `no language server for "${langId}"`);
        } catch {
          // already closing
        }
        return;
      }
      proxyFor(entry).attach(adaptWs(ws));
    });
    return true;
  };

  const dispose = (): void => {
    for (const proxy of proxies.values()) {
      proxy.dispose();
    }
    proxies.clear();
    wss.close();
  };

  return { handleHttp, handleUpgrade, dispose };
}
