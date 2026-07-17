/**
 * The detached panel as a **channel sidecar** — the Phase-2 endgame: the
 * channel SERVES the intent client, so the page's origin IS the channel and
 * discovery disappears (session.ts's same-origin resolution takes over; no
 * `?channel=` needed, no port probing, no native host — ever).
 *
 * Mounted under `/intent/` on the channel's one port, exactly like the iPad
 * paint page under `/paint/` (the standing exception to "the channel serves
 * no HTML": a page whose frontend process IS the channel). HOW it is served is
 * a {@link SidecarContext.mode} decision, delegated to the shared helper
 * (aiui-util's `serveClientSurface`): in DEV a Vite dev server in middleware
 * mode rooted at this package — source-first, HMR riding the channel's one port
 * via a shim; in PROD the prebuilt static bundle under `assets/panel` (built by
 * `build:panel`), so an installed session needs no Vite. The standalone
 * `pnpm dev` page remains a second hot-iteration surface; the channel-served
 * page is the always-there one, and in dev it hot-reloads too.
 *
 * Reachability follows the channel's bind decision (`channel.bind`), same
 * as paint — the sidecar adds no listener and no new posture.
 */

import { fileURLToPath } from "node:url";
import type { MountedSidecar, Sidecar, SidecarContext } from "@habemus-papadum/aiui-claude-channel";
import { serveClientSurface } from "@habemus-papadum/aiui-util/web-surface";
import type { Express } from "express";
import { WebSocket } from "ws";
import type { CdpSocket } from "./cdp/protocol";
import { startCdpTagger } from "./cdp/tagger";
import { createCdpProxy } from "./cdp-proxy";

/** The path prefix the panel lives under on the channel's server. */
export const INTENT_PREFIX = "/intent";

/** The global the injected page bundle defines in the victim page. */
export const PAGE_GLOBAL = "__aiuiIntentPage";

/**
 * Bundle `src/cdp/page-bundle.ts` (locator · jump · pencil) into one IIFE
 * that assigns {@link PAGE_GLOBAL}. Built on demand — this is a dev-time
 * surface, and a rebuild costs tens of milliseconds — so editing the page
 * surfaces needs no restart, just a page that mounts them again.
 */
export async function pageBundle(): Promise<string> {
  const { build } = await import("esbuild");
  const entry = fileURLToPath(new URL("./cdp/page-bundle.ts", import.meta.url));
  const bundled = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "__aiuiIntentPageExports",
    platform: "browser",
    target: "es2022",
    logLevel: "silent",
  });
  // MERGE the exports into the page global — never assign over it. The
  // page-script's capability surface (v · adopt · hello · handle) lives on the
  // SAME object, and `globalName: PAGE_GLOBAL` was found live (2026-07-17)
  // replacing it wholesale: the moment the bundle landed, `handle` was gone,
  // so heartbeats/pencil/region all evaluated to a swallowed TypeError while
  // the claims read "active". (The page-script's install merges in the other
  // direction for the same reason.) The arrow wrapper keeps the IIFE's `var`
  // function-scoped, so nothing but the merged global lands on the page.
  return `(() => { ${bundled.outputFiles[0].text}
Object.assign(window.${PAGE_GLOBAL} = window.${PAGE_GLOBAL} || {}, __aiuiIntentPageExports); })();`;
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

      // The CDP tagger + endpoint watcher (see cdp/tagger.ts). The tagger
      // writes this channel's port into the extension THROUGH the browser's
      // own debug endpoint — same-browser proof the extension's discovery
      // reads first. The watcher rides the same discovery beat: if the
      // endpoint MOVES after startup (browser relaunched → new ephemeral
      // port), everything pinned at launch — the Chrome DevTools MCP above
      // all — still points at the dead browser, invisibly. That is exactly
      // when the agent should ask the user to restart, so we push the fact
      // into the session via the channel's own `/prompt` route.
      let bootUrl: string | undefined; // the endpoint at startup
      let warnedUrl: string | undefined; // the move we already reported
      const warnEndpointMoved = async (was: string, now: string): Promise<void> => {
        const port = ctx.port();
        ctx.log(`intent: the session browser's CDP endpoint moved (${was} -> ${now})`);
        if (port === undefined) {
          return;
        }
        const text =
          `[aiui intent] The session browser's CDP endpoint changed while this channel was ` +
          `running: it was ${was} at startup and is now ${now} (the browser was relaunched). ` +
          `Connections pinned at launch — notably the Chrome DevTools MCP — still point at the ` +
          `dead endpoint. Let the user know and suggest restarting \`aiui claude\` so the ` +
          `session rebinds to the live browser.`;
        try {
          await fetch(`http://127.0.0.1:${port}/prompt`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text }),
          });
        } catch {
          // The session may be gone; the log line above still tells the story.
        }
      };
      const stopTagger = startCdpTagger({
        channelPort: () => ctx.port(),
        endpoint: async () => {
          const info = await cdp.info(ctx.port());
          const url = info.available ? info.browserUrl : undefined;
          if (url !== undefined) {
            if (bootUrl === undefined) {
              bootUrl = url;
            } else if (url !== bootUrl && url !== warnedUrl) {
              warnedUrl = url;
              void warnEndpointMoved(bootUrl, url);
            }
          }
          return url;
        },
        log: ctx.log,
        // The node `ws` client speaks the CdpSocket surface the tagger needs.
        socketFactory: (url) => new WebSocket(url) as unknown as CdpSocket,
      });
      app.use((req, res, next) => {
        if (req.path === `${INTENT_PREFIX}/page-bundle.js`) {
          // The page bundle (locator · jump · pencil), bundled to ONE
          // self-contained script for the bus to evaluate inside a victim page.
          //
          // It cannot be an ES module the page imports: the channel is
          // `http://127.0.0.1:…`, and any https page — i.e. most of the web —
          // blocks that import as mixed content (found live: the ring landed
          // on example.com, the surfaces silently did not). So the page fetches
          // NOTHING. The panel reads this route from its own origin and hands
          // the source to the page over CDP. Same reason the bootstrap is a
          // stringified function.
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.type("application/javascript");
          void pageBundle()
            .then((source) => res.end(source))
            .catch((err: unknown) => {
              ctx.log(`intent: could not build the page bundle — ${String(err)}`);
              res.status(500).end("/* page bundle failed */");
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

      // How the panel is served is a mode decision, delegated to the shared
      // helper (aiui-util's serveClientSurface): in DEV a Vite dev server in
      // middleware mode rooted at this package (source-first, HMR riding the
      // channel's one port via a shim); in PROD the prebuilt static bundle under
      // `assets/panel` (built by `build:panel`). The special routes registered
      // above (page-bundle, /cdp/info) go on first, so they win over the client
      // middleware. `base`/prefix scoping means requests outside /intent/ fall
      // through to the channel's own routes, per the sidecar rule.
      const surface = await serveClientSurface(app, {
        mode: ctx.mode,
        prefix: INTENT_PREFIX,
        viteRoot: fileURLToPath(new URL("..", import.meta.url)),
        distDir: fileURLToPath(new URL("../assets/panel", import.meta.url)),
        notBuiltHint: "pnpm -C packages/aiui-intent-client build:panel",
        log: ctx.log,
      });
      return {
        // The surface claims its HMR socket (dev only); everything else the
        // channel didn't handle is the CDP bridge's.
        handleUpgrade: (req, socket, head) =>
          surface.handleUpgrade?.(req, socket, head) === true ||
          cdp.handleUpgrade(req, socket, head),
        dispose: async () => {
          stopTagger();
          cdp.dispose();
          await surface.dispose?.();
        },
      };
    },
  };
}
