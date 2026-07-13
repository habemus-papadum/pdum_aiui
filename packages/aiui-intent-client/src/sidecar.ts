/**
 * The detached panel as a **channel sidecar** — the Phase-2 endgame: the
 * channel SERVES the intent client, so the page's origin IS the channel and
 * discovery disappears (session.ts's same-origin resolution takes over; no
 * `?channel=` needed, no port probing, no native host — ever).
 *
 * Mounted under `/intent/` on the channel's one port, exactly like the iPad
 * paint page under `/paint/` (the standing exception to "the channel serves
 * no HTML": a page whose frontend process IS the channel). Serving is a Vite
 * dev server in middleware mode rooted at this package — source-first, like
 * everything in the workspace; a static dist build can replace it at
 * packaging time (Phase 4). HMR is off through the channel (the standalone
 * `pnpm dev` page remains the hot-iteration surface); the channel-served
 * page is the stable, always-there one.
 *
 * Reachability follows the channel's bind decision (`channel.bind`), same
 * as paint — the sidecar adds no listener and no new posture.
 */

import { fileURLToPath } from "node:url";
import type { MountedSidecar, Sidecar, SidecarContext } from "@habemus-papadum/aiui-claude-channel";
import type { Express } from "express";
import { createCdpProxy } from "./cdp-proxy";

/** The path prefix the panel lives under on the channel's server. */
export const INTENT_PREFIX = "/intent";

/** The global the injected ink bundle defines in the victim page. */
export const INK_GLOBAL = "__aiuiIntentInk";

/**
 * Bundle `src/cdp/page-ink.ts` (and the ink library under it) into one IIFE
 * that assigns {@link INK_GLOBAL}. Built on demand — this is a dev-time
 * surface, and a rebuild costs tens of milliseconds — so editing the ink
 * surface needs no restart, just a page that mounts it again.
 */
export async function pageInkBundle(): Promise<string> {
  const { build } = await import("esbuild");
  const entry = fileURLToPath(new URL("./cdp/page-ink.ts", import.meta.url));
  const bundled = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "iife",
    globalName: INK_GLOBAL,
    platform: "browser",
    target: "es2022",
    logLevel: "silent",
  });
  return bundled.outputFiles[0].text;
}

export interface IntentSidecarOptions {
  /** Project root — locates the session browser's profile for the CDP bridge. */
  root?: string;
}

/** Package the detached panel as a channel {@link Sidecar}. */
export function intentSidecar(options: IntentSidecarOptions = {}): Sidecar {
  return {
    name: "intent",
    async mount(app: Express, ctx: SidecarContext): Promise<MountedSidecar> {
      // The CDP bridge (see cdp-proxy.ts): the panel's page cannot dial the
      // browser's debug port itself, so the channel does it on its behalf.
      const cdp = createCdpProxy({ root: options.root, log: ctx.log });
      app.use((req, res, next) => {
        if (req.path === `${INTENT_PREFIX}/page-ink.js`) {
          // The ink surface, bundled to ONE self-contained script for the bus
          // to evaluate inside a victim page.
          //
          // It cannot be an ES module the page imports: the channel is
          // `http://127.0.0.1:…`, and any https page — i.e. most of the web —
          // blocks that import as mixed content (found live: the ring landed
          // on example.com, the ink silently did not). So the page fetches
          // NOTHING. The panel reads this route from its own origin and hands
          // the source to the page over CDP. Same reason the bootstrap is a
          // stringified function.
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.type("application/javascript");
          void pageInkBundle()
            .then((source) => res.end(source))
            .catch((err: unknown) => {
              ctx.log(`intent: could not bundle the page ink surface — ${String(err)}`);
              res.status(500).end("/* ink bundle failed */");
            });
          return;
        }
        if (req.path === `${INTENT_PREFIX}/cdp/info`) {
          // The standalone `pnpm dev` page probes this from ITS origin (the
          // Vite dev server), like the paint sidecar's /info — hence the CORS.
          res.setHeader("Access-Control-Allow-Origin", "*");
          const port = Number(req.socket.localPort);
          void cdp
            .info(Number.isInteger(port) ? port : undefined)
            .then((info) => res.json(info))
            .catch(() => res.json({ ok: true, available: false, reason: "discovery failed" }));
          return;
        }
        next();
      });

      // Vite resolves this package's own vite.config.ts (solid plugin et al).
      // `base` scopes the middlewares to /intent/* — requests outside the
      // base fall through to the channel's own routes, per the sidecar rule.
      const { createServer } = await import("vite");
      const packageRoot = fileURLToPath(new URL("..", import.meta.url));
      const vite = await createServer({
        root: packageRoot,
        base: `${INTENT_PREFIX}/`,
        appType: "mpa",
        server: { middlewareMode: true, hmr: false },
        clearScreen: false,
        logLevel: "warn",
      });
      app.use(vite.middlewares);
      ctx.log(`intent client mounted at ${INTENT_PREFIX}/ (vite middleware, source-first)`);
      return {
        handleUpgrade: (req, socket, head) => cdp.handleUpgrade(req, socket, head),
        dispose: async () => {
          cdp.dispose();
          await vite.close();
        },
      };
    },
  };
}
