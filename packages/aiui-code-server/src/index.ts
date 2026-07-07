/**
 * @habemus-papadum/aiui-code-server — the **backend** for the aiui code reader.
 *
 * The cwd-bound HTTP surface under `/__aiui_code` (file tree/read, walkthroughs,
 * configured LSP servers) plus the `/lsp` websocket byte-relay that spawns the
 * project's real language servers. It speaks the wire contract from
 * `@habemus-papadum/aiui-code-protocol`; the reader frontend
 * (`@habemus-papadum/aiui-code`) is the client.
 *
 * Two host shapes ship alongside this core:
 *  - `@habemus-papadum/aiui-code-server/vite` — mount it on a Vite dev server
 *    (the standalone reader harness).
 *  - `@habemus-papadum/aiui-code-server/sidecar` — mount it on the aiui channel's
 *    Express app (the primary path: one session process serves the reader).
 */

export {
  type AiuiCodeBackendDeps,
  type MountedBackend,
  mountAiuiCodeBackend,
} from "./backend";
export {
  createWalkthroughStore,
  type WalkthroughStore,
  type WalkthroughStoreOptions,
} from "./walkthrough-store";
