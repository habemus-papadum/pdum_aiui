/**
 * @habemus-papadum/aiui-lsp — the project-local LSP subsystem shared by the
 * code reader and (in time) the channel process.
 *
 * Three pieces:
 *  - **the descriptor format** (`manifest.ts`): a thin `.aiui/lsp/manifest.json`
 *    index pointing at per-language executable launchers.
 *  - **the proxy** (`proxy.ts`): a language-agnostic stdio ↔ websocket byte relay
 *    that spawns a launcher and pipes genuine LSP JSON-RPC — no veneer.
 *  - **the probe** (`probe.ts`): a headless self-test that runs a real handshake
 *    against a launcher, so `aiui setup-lsp` never records an untested server.
 *
 * `providers.ts` + `generate.ts` are the setup side: built-in recipes for
 * well-known languages and the writers that lay down launchers/docs/manifest.
 */

export type { EnsureOptions } from "./generate";
export {
  BOOTSTRAP_GENERATION,
  ensureDefaultManifest,
  provisionServer,
  writeLauncher,
  writeManifest,
  writeSetupDoc,
} from "./generate";
export type { LspManifest, LspServerEntry, LspVerification } from "./manifest";
export {
  cacheLspDir,
  LSP_SUBDIR,
  languageIdForPath,
  launcherPath,
  loadManifest,
  lspDir,
  MANIFEST_FILENAME,
  manifestPath,
  PROJECT_CACHE_DIRNAME,
  PROJECT_DIRNAME,
  resolveLspDir,
  serverForExtension,
  serverForLanguageId,
  validateManifest,
} from "./manifest";

export type { ProbeOp, ProbeOpResult, ProbeOptions, ProbeReport } from "./probe";
export { probeLauncher } from "./probe";

export type { BuildOptions, BuiltLauncher, ProviderRecipe } from "./providers";
export { detectLanguages, PROVIDERS } from "./providers";
export type {
  LspChild,
  LspLaunch,
  LspProxy,
  LspProxyOptions,
  LspSocket,
  MessageDecoder,
  SpawnLspChild,
} from "./proxy";
export { createLspProxy, createMessageDecoder, frameMessage, spawnNodeChild } from "./proxy";
