import { fileURLToPath } from "node:url";
import { aiui } from "@habemus-papadum/aiui-source-processor";
import { defineConfig, type Plugin } from "vite";
import solid from "vite-plugin-solid";
// Relative, not the package specifier: vite bundles a config's RELATIVE imports
// with esbuild (which handles extensionless TS), but externalizes package
// imports to node's ESM resolver — which cannot resolve the bar backend's own
// `./protocol` (no extension) and refuses to start the server.
import { createBarBackend } from "../../aiui-remote-bar/src/backend";
import { createPencilBackend } from "../src/backend";
import { clientStatic } from "../src/client-static";

/**
 * Mount the pencil relay INTO the Lab's own dev server.
 *
 * This is the same `createPencilBackend` the channel sidecar mounts at
 * `/pencil` — literally the same code path — so the whole remote loop (host
 * page, relay, client page) runs out of `pnpm lab` with no channel process
 * anywhere. That is the C2 test rig from the plan, and it is also the honest
 * claim that the sidecar seam is host-neutral: if it only worked under the
 * channel's Express app, it would not be.
 *
 * The upgrade hook claims only `/pencil/*` paths — Vite's own HMR websocket
 * must keep working, or every edit to the Lab would hard-reload it.
 */
function pencilRelay(): Plugin {
  return {
    name: "pencil-relay",
    configureServer(server) {
      const backend = createPencilBackend({
        prefix: "/pencil",
        session: { project: "pencil-lab" },
        log: (line) => server.config.logger.info(line),
      });
      // The bar channel too (D5): the served client shows the host's command
      // bar, so the rig must carry both sockets the way the channel does.
      const bar = createBarBackend({
        prefix: "/bar",
        session: { project: "pencil-lab" },
        log: (line) => server.config.logger.info(line),
      });
      // The BUILT client artifact at /pencil/ — the very page the channel
      // sidecar serves an iPad — so the deployable is testable on this origin
      // (HMR iteration on the client app: `pnpm dev:client`). 503s with the build
      // command until `pnpm build:client` has run.
      // The dir is passed explicitly: this code is BUNDLED into vite's temp
      // config file, where client-static's own import.meta.url (its default)
      // points into the bundle, not the package. Vite preserves the config
      // file's import.meta.url, so derive from here.
      const page = clientStatic(
        "/pencil",
        fileURLToPath(new URL("../assets/client", import.meta.url)),
      );
      server.middlewares.use((req, res, next) => {
        if (!backend.handleHttp(req, res) && !bar.handleHttp(req, res) && !page.handle(req, res)) {
          next();
        }
      });
      server.httpServer?.on("upgrade", (req, socket, head) => {
        if (req.url?.startsWith("/pencil/")) {
          backend.handleUpgrade(req, socket, head);
        } else if (req.url?.startsWith("/bar/")) {
          bar.handleUpgrade(req, socket, head);
        }
      });
      server.httpServer?.on("close", () => {
        backend.dispose();
        bar.dispose();
      });
    },
  };
}

/**
 * Pencil Lab's dev server.
 *
 * `aiui({ locator: true })` is not optional decoration here: the aiui compiler
 * is what injects `control()` names from their bindings, and without it every
 * control in store.ts throws "needs a name". It also stamps source locations so
 * the intent tool can resolve a drag on the canvas back to the code that drew it.
 *
 * Order matters — the locator's `pre` babel pass must stamp JSX *before*
 * vite-plugin-solid (also `pre`) compiles each element into an opaque template.
 * Same-enforce plugins run in array order.
 *
 * `root` is this directory: the Lab is an app living inside the library package,
 * not a workspace member of its own. It
 * imports the library through `@habemus-papadum/aiui-pencil`, which resolves to
 * SOURCE via the package's own `exports` — so editing the pipeline hot-reloads
 * the Lab with no build step.
 */
export default defineConfig({
  // NOT `__dirname`: this package is `"type": "module"`, so the config is loaded
  // as ESM and `__dirname` is undefined — Vite then silently roots at the CWD
  // (the package dir), finds no index.html, and serves a 404 at `/`. Derive it
  // from the module URL instead.
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [pencilRelay(), aiui({ locator: true }), solid()],
  server: {
    // The iPad is a different machine. Binding to 0.0.0.0 is the whole point of
    // this app existing — see the trusted-LAN note in docs/guide/warning.md.
    host: true,
  },
});
