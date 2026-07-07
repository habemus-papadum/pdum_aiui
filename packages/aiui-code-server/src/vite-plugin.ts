/**
 * vite-plugin.ts — the dev-server host for the reader's backend.
 *
 * Mounts {@link mountAiuiCodeBackend} onto THIS Vite dev server: the
 * `/__aiui_code/*` HTTP routes via a connect middleware, and the `/lsp` byte
 * relay via the http server's `upgrade` event. The upgrade handler only claims
 * its own path and otherwise returns without touching the socket, so Vite's own
 * HMR websocket keeps working.
 */
import { fileURLToPath } from "node:url";
import { AIUI_CODE_PREFIX } from "@habemus-papadum/aiui-code-protocol";
import type { Plugin } from "vite";

export interface AiuiCodeBackendOptions {
  /** Absolute path to the project the reader serves + runs the LSP against. */
  root: string;
}

export function aiuiCodeBackendPlugin(options: AiuiCodeBackendOptions): Plugin {
  return {
    name: "aiui-code-backend",
    async configureServer(server) {
      // Load the backend through Vite's SSR pipeline rather than a static import:
      // it (transitively) imports the workspace source of @habemus-papadum/aiui-lsp,
      // whose extensionless TS imports the config-file esbuild bundler can't resolve
      // (it would externalize the package and hand its raw .ts to Node). SSR
      // transpiles workspace source the same way the browser build does.
      const backendPath = fileURLToPath(new URL("./backend.ts", import.meta.url));
      const { mountAiuiCodeBackend } = (await server.ssrLoadModule(
        backendPath,
      )) as typeof import("./backend");
      const backend = mountAiuiCodeBackend({
        root: options.root,
        onLog: (line) => server.config.logger.info(`[aiui-code] ${line}`),
      });

      server.middlewares.use(async (req, res, next) => {
        if (req.url?.startsWith(AIUI_CODE_PREFIX)) {
          const handled = await backend.handleHttp(req, res);
          if (handled) {
            return;
          }
        }
        next();
      });

      server.httpServer?.on("upgrade", (req, socket, head) => {
        backend.handleUpgrade(req, socket, head);
      });
      server.httpServer?.on("close", () => backend.dispose());
    },
  };
}
