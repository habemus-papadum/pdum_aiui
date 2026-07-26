import { fileURLToPath } from "node:url";
import { aiui } from "@habemus-papadum/aiui-source-processor";
import { defineConfig, type Plugin } from "vite";
import solid from "vite-plugin-solid";
// Relative, not the package specifier: vite bundles a config's RELATIVE
// imports with esbuild but hands package imports to node's ESM resolver
// (the pencil lab's lesson).
import { createMintBackend } from "../src/mint-backend";
import { oracleDevKey } from "../src/vite";

/**
 * Mount the mint endpoint INTO the lab's dev server — the dev-mode key flow:
 * the parent key stays in this process's environment (direnv/.env), the page
 * fetches short-lived `ek_`s from `POST /oracle/mint`. The SAME backend runs
 * standalone (runMintServer) and, later, under the channel sidecar — one
 * code path, which is what makes the sidecar seam honest.
 */
function oracleMint(): Plugin {
  return {
    name: "oracle-mint",
    configureServer(server) {
      const backend = createMintBackend({
        log: (line) => server.config.logger.info(line),
      });
      server.middlewares.use((req, res, next) => {
        if (!backend.handleHttp(req, res)) {
          next();
        }
      });
    },
  };
}

/**
 * Oracle Lab's dev server — the pencil playbook, minus the relay (the oracle
 * talks to the vendor directly; there is no backend to mount).
 *
 * `aiui({ locator: true })` is load-bearing: the aiui compiler injects
 * `control()` names from their bindings (without it every control in store.ts
 * throws "needs a name") and stamps source locations. Order matters — its
 * `pre` babel pass must run before vite-plugin-solid compiles JSX away.
 *
 * `root` from the module URL, NOT `__dirname` (undefined in a `"type":
 * "module"` package — Vite would silently root at the CWD and 404).
 */
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  // All three key flows live here: the mint endpoint (oracleMint), the
  // injected dev key (oracleDevKey — serve-only), and paste-key in the page.
  plugins: [oracleMint(), oracleDevKey(), aiui({ locator: true }), solid()],
  server: {
    // A LAN device (the iPad) may join — the trusted-LAN posture,
    // docs/guide/warning.md. Note the mic needs a secure context: fine on
    // localhost; a LAN address wants the CfT flag or https.
    host: true,
  },
});
