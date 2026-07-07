/**
 * protocol.ts — the wire contract shared by the reader's backend (Node, under
 * the dev server or, later, the channel process) and its browser client.
 *
 * Everything here is transport-agnostic plumbing: HTTP route strings, the shapes
 * they carry, and the `/lsp` websocket convention. Keeping it in one module is
 * what lets the two halves be built and tested independently, and lets the whole
 * backend be lifted into the channel process later without renaming a thing.
 *
 * The design rule from the proposal (docs/proposals/code-reader.md, §"No
 * veneer"): the `/lsp` socket is a *byte relay*. The browser runs a real LSP
 * client; the backend reframes `Content-Length`-framed JSON-RPC ↔ one JSON
 * message per websocket text frame and spawns the real language server. Nothing
 * in the middle understands or rewrites LSP semantics.
 */

/** All reader endpoints live under this prefix so a host (vite dev server today,
 * the channel tomorrow) can mount them without colliding with its own routes. */
export const AIUI_CODE_PREFIX = "/__aiui_code";

export const ROUTES = {
  /** GET → {@link BackendInfo}. Cheap capability probe. */
  info: `${AIUI_CODE_PREFIX}/info`,
  /** GET → {@link FileTreeResponse}. The project's readable files (flat list). */
  tree: `${AIUI_CODE_PREFIX}/files/tree`,
  /** GET `?path=<rel>` → {@link FileReadResponse}. One file's text. */
  read: `${AIUI_CODE_PREFIX}/files/read`,
  /** GET → {@link WalkthroughListResponse}; POST {@link Walkthrough} → {id}. */
  walkthroughs: `${AIUI_CODE_PREFIX}/walkthroughs`,
  /** GET → {@link LspServersResponse}. The project's configured language servers. */
  lspServers: `${AIUI_CODE_PREFIX}/lsp/servers`,
  /** WS. Byte-relay to the language server for the file's language.
   * Query: `?lang=<languageId>` (e.g. `python`). */
  lsp: `${AIUI_CODE_PREFIX}/lsp`,
} as const;

/** GET a single walkthrough by id: `${walkthroughs}/<id>`. */
export const walkthroughPath = (id: string): string =>
  `${ROUTES.walkthroughs}/${encodeURIComponent(id)}`;

/** Build the `/lsp` websocket URL for a language against a backend origin. */
export function lspSocketUrl(origin: string, languageId: string): string {
  const u = new URL(ROUTES.lsp, origin);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.searchParams.set("lang", languageId);
  return u.toString();
}

// --- files -----------------------------------------------------------------

export interface FileEntry {
  /** Project-relative POSIX path (e.g. `pkg/geometry.py`). */
  path: string;
  type: "file" | "dir";
}

export interface FileTreeResponse {
  /** Absolute project root the backend is serving (informational). */
  root: string;
  entries: FileEntry[];
}

export interface FileReadResponse {
  path: string;
  content: string;
  /** LSP/Monaco language id inferred from the extension (e.g. `python`). */
  languageId: string;
}

// --- capability probe ------------------------------------------------------

export interface BackendInfo {
  ok: true;
  root: string;
  /** Language ids the backend can start a server for (has a spec + a resolvable binary). */
  languages: string[];
}

// --- walkthroughs (Tier 3) — see walkthrough.ts ----------------------------

import type { WalkthroughSummary } from "./walkthrough";

export interface WalkthroughListResponse {
  walkthroughs: WalkthroughSummary[];
}

// --- language servers (from the project's .aiui/lsp manifest) --------------

/** One configured server, as the reader's frontend sees it (no launcher paths). */
export interface LspServerInfo {
  language: string;
  languageId: string;
  extensions: string[];
  name?: string;
  /** Whether the setup's self-test passed, if it was recorded. */
  verified?: boolean;
  /** `initializationOptions` the client must send at `initialize`. */
  initializationOptions?: Record<string, unknown>;
}

export interface LspServersResponse {
  servers: LspServerInfo[];
}
