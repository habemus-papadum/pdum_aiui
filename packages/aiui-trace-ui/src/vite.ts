/**
 * The trace viewer's Vite plugin: serve the standalone trace-debugger page at
 * {@link DEBUG_ROUTE} (`/__aiui/debug`) on whatever dev server loads it.
 *
 * This is the serving half the retired dev-overlay plugin used to carry, now
 * owned by the package that owns the panes: the page is a thin shell — it
 * seeds the channel port on `window.__AIUI__`, pulls in Vite's HMR client,
 * and boots via a virtual mount module that imports {@link mountDebugPage}
 * from this package. `aiui debug` is the standing consumer (the channel
 * serves no HTML; every page belongs to a frontend process); an app dev
 * server can load it too if it wants the viewer beside the app.
 *
 * Dev-server only (`apply: "serve"`): the viewer is a development surface,
 * never part of a build.
 */

import type { Plugin } from "vite";

/** The route this plugin serves the trace debugger at. */
export const DEBUG_ROUTE = "/__aiui/debug";

/** The virtual module that boots the page (imports this package's entry). */
const DEBUG_MOUNT_ID = "virtual:aiui-trace-ui/debug";

const PKG = "@habemus-papadum/aiui-trace-ui";

export interface TraceViewerOptions {
  /**
   * The channel port the page polls. Omitted, the page falls back to a
   * pre-seeded `window.__AIUI__.port` and otherwise says how to launch so it
   * knows one (see `mountDebugPage`).
   */
  port?: number;
}

/** Serve the standalone trace-debugger page at {@link DEBUG_ROUTE}. */
export function traceViewer(options: TraceViewerOptions = {}): Plugin {
  return {
    name: "aiui:trace-viewer",
    apply: "serve",
    // Deliberately NO `optimizeDeps.include` for this package: the dep
    // optimizer's cache is keyed by the lockfile, not by package contents, so
    // a workspace-linked copy would be served stale after every rebuild.
    resolveId(id) {
      return id === DEBUG_MOUNT_ID ? DEBUG_MOUNT_ID : undefined;
    },
    load(id) {
      if (id !== DEBUG_MOUNT_ID) {
        return undefined;
      }
      return [
        `import { mountDebugPage } from ${JSON.stringify(PKG)};`,
        `mountDebugPage(${options.port === undefined ? "{}" : `{ port: ${options.port} }`});`,
        "",
      ].join("\n");
    },
    configureServer(server) {
      // The page deliberately does NOT go through transformIndexHtml — it is
      // a debugger view, not an app page, so app-level HTML transforms (and
      // whatever they inject) stay out of it.
      const seed = options.port === undefined ? "" : ` window.__AIUI__.port = ${options.port};`;
      const shell = [
        "<!doctype html>",
        '<html lang="en"><head>',
        '<meta charset="utf-8" />',
        '<meta name="viewport" content="width=device-width, initial-scale=1" />',
        "<title>aiui · lowering traces</title>",
        `<script>window.__AIUI__ ??= { v: 1, frames: [] };${seed}</script>`,
        '<script type="module" src="/@vite/client"></script>',
        `<script type="module" src="/@id/${DEBUG_MOUNT_ID}"></script>`,
        "</head><body></body></html>",
      ].join("\n");
      server.middlewares.use((req, res, next) => {
        if ((req.url ?? "").split("?")[0] !== DEBUG_ROUTE) {
          next();
          return;
        }
        res.statusCode = 200;
        res.setHeader("content-type", "text/html");
        res.end(shell);
      });
    },
  };
}
