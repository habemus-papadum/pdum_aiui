/**
 * The detached panel as a **channel sidecar** — the Phase-2 endgame: the
 * channel SERVES the intent client, so the page's origin IS the channel and
 * discovery disappears (session.ts's same-origin resolution takes over; no
 * `?channel=` needed, no port probing, no native host — ever).
 *
 * Mounted under `/intent/` on the channel's one port, exactly like the iPad
 * pencil page under `/pencil/` (the standing exception to "the channel serves
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
 * as pencil — the sidecar adds no listener and no new posture.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MountedSidecar, Sidecar, SidecarContext } from "@habemus-papadum/aiui-claude-channel";
import {
  absentKeyPhrase,
  LOCAL_READ_TOOLS,
  vendorKey,
} from "@habemus-papadum/aiui-claude-channel/internal";
import { createMintBackend } from "@habemus-papadum/aiui-oracle/server";
import { discoverSessionBrowserInProfiles } from "@habemus-papadum/aiui-util";
import { serveClientSurface } from "@habemus-papadum/aiui-util/web-surface";
import type { Express } from "express";
import { WebSocket } from "ws";
import type { CdpSocket } from "./cdp/protocol";
import { startCdpTagger } from "./cdp/tagger";
import { browserUrlFromLaunchInfo, createCdpProxy } from "./cdp-proxy";

/** The path prefix the panel lives under on the channel's server. */
const INTENT_PREFIX = "/intent";

// join(), never `new URL(rel, import.meta.url)`: Vite's lib build rewrites
// that pattern — file targets get inlined as data: URLs, and even the bare
// ".." viteRoot below was resolved through the package entry and inlined —
// which made the eager fileURLToPath throw at mount time in an installed
// dist (v0.8.0).
const here = dirname(fileURLToPath(import.meta.url));

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
  const entry = join(here, "cdp/page-bundle.ts");
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
      // reads first. The watcher rides the same discovery beat: if the LIVE
      // session browser drifts away from the endpoint pinned at launch (browser
      // relaunched → new ephemeral port), everything pinned then — the Chrome
      // DevTools MCP above all — still points at the dead browser, invisibly.
      // That is exactly when the agent should ask the user to restart, so we
      // push the fact into the session via the channel's own `/prompt` route.
      //
      // The anchor is the AUTHORITATIVE launch info — what `aiui claude` handed
      // the MCP — never a profile scan. Seeding the baseline from a scan let a
      // startup-race read of a DIFFERENT live browser masquerade as a move (the
      // phantom-warning bug, 2026-07-20); the "now" side is a scan of the LIVE
      // session profile, which is what a real relaunch actually moves.
      let pinnedUrl: string | undefined; // the MCP's pin (launch info), the anchor
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
      const tagger = startCdpTagger({
        channelPort: () => ctx.port(),
        endpoint: async () => {
          const channelPort = ctx.port();
          // Anchor once on the launch info — the endpoint the MCP was pinned to.
          if (pinnedUrl === undefined && channelPort !== undefined) {
            pinnedUrl = await browserUrlFromLaunchInfo(channelPort);
          }
          // The session browser running NOW, probed independently of the
          // (frozen) launch info: a real relaunch moves the live profile's
          // DevToolsActivePort, and only that divergence from the pin warrants
          // the warning.
          const live = (await discoverSessionBrowserInProfiles())?.browserUrl;
          if (
            pinnedUrl !== undefined &&
            live !== undefined &&
            live !== pinnedUrl &&
            live !== warnedUrl
          ) {
            warnedUrl = live;
            void warnEndpointMoved(pinnedUrl, live);
          }
          // Tag through the endpoint the panel bridges to (launch-info-first).
          const info = await cdp.info(channelPort);
          return info.available ? info.browserUrl : undefined;
        },
        log: ctx.log,
        // The node `ws` client speaks the CdpSocket surface the tagger needs.
        socketFactory: (url) => new WebSocket(url) as unknown as CdpSocket,
      });
      // The oracle's credential mint (O3a of the intent-oracle proposal, git history):
      // `POST /intent/oracle/mint`. The panel's oracle needs an ephemeral `ek_`
      // to open a realtime session, and this is the honest end of the
      // installed-keys posture — the PARENT key stays in the channel process
      // and the page only ever sees the short-lived secret.
      //
      // The key comes from the channel's boot-time STASH, never
      // `process.env`: an installed channel resolves the OS vault into the
      // stash precisely so keys never enter an environment (`vendorKey`,
      // the channel's internal seam). `absentKeyPhrase` then distinguishes
      // "skipped by choice" from "missing" in the 503 the mint returns
      // keyless — the backend degrades loudly by design.
      // TTL is set here because the SERVER owns it: the page POSTs a session
      // config and gets a secret back, never a duration. Ten minutes is
      // deliberately far more than needed — the panel mints one credential per
      // session (lanes/oracle.ts) and it only has to survive the WebRTC
      // offer/answer that follows, so the TTL is slack for a slow handshake,
      // not a budget for reuse. Note the two independent clocks: this bounds
      // how long a secret may OPEN a session; the vendor's ~60 minutes bounds
      // how long an opened session runs, and a session that outlives its
      // credential is normal and fine.
      const mint = createMintBackend({
        prefix: `${INTENT_PREFIX}/oracle`,
        resolveKey: () => vendorKey("OPENAI_API_KEY"),
        ttlSeconds: 600,
        log: (line) => ctx.log(`intent: ${line}`),
      });
      app.use((req, res, next) => {
        if (req.path === `${INTENT_PREFIX}/oracle/tool` && req.method === "POST") {
          // The oracle's LOCAL-READ tools (O3c): `read_file`, `list_files`,
          // `grep`. The oracle runs in the browser and speaks WebRTC straight
          // to the vendor, so reaching a filesystem has to cross into node —
          // and this is the crossing. ONE route with a dispatch table rather
          // than three, mirroring the shape `runConsumerToolCall` already uses
          // for the linter.
          //
          // The executors, their caps, and the policy are the CHANNEL's
          // (linter-tools.ts): the same code the prompt linter runs, so a
          // read's rules cannot drift between the two consumers — only which
          // subset each advertises. `root` is the project the session is
          // about, which is exactly the prompt cwd relative paths resolve
          // against.
          const chunks: Buffer[] = [];
          let size = 0;
          req.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 64 * 1024) {
              req.destroy();
              return;
            }
            chunks.push(chunk);
          });
          req.on("end", () => {
            let payload: { tool?: unknown; args?: unknown };
            try {
              payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
            } catch {
              res.status(400).json({ ok: false, error: "body was not valid JSON" });
              return;
            }
            const tool = typeof payload.tool === "string" ? payload.tool : "";
            const run = LOCAL_READ_TOOLS[tool];
            if (run === undefined) {
              // Answered IN BAND, like every other tool failure: the vendor has
              // no error channel for tools, so the model must be able to read
              // what went wrong.
              res.json({ ok: false, content: `unknown tool "${tool}"`, summary: "unknown tool" });
              return;
            }
            const args =
              payload.args !== null && typeof payload.args === "object"
                ? (payload.args as Record<string, unknown>)
                : {};
            const result = run(args, options.root);
            ctx.log(`intent: oracle ${tool} — ${result.summary}`);
            res.json(result);
          });
          return;
        }
        if (req.path === `${INTENT_PREFIX}/oracle/mint`) {
          if (vendorKey("OPENAI_API_KEY") === undefined) {
            // Name the absence the way the rest of the channel does before the
            // backend's generic remedy line takes over.
            ctx.log(`intent: oracle mint asked for, but ${absentKeyPhrase("OPENAI_API_KEY")}`);
          }
          if (mint.handleHttp(req, res)) {
            return;
          }
        }
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
          // Vite dev server), like the pencil sidecar's /info — hence the CORS.
          res.setHeader("Access-Control-Allow-Origin", "*");
          const port = Number(req.socket.localPort);
          void cdp
            .info(Number.isInteger(port) ? port : undefined)
            // The tagger's landed status rides along — the client's
            // CDP-ALIGNMENT verdict needs the channel's side of the evidence
            // ("did my tag land anywhere?"; src/cdp-align.ts). Distinct field
            // names: `browserUrl` is the live endpoint, `taggedBrowserUrl`
            // where the tag last landed (they differ after an endpoint move).
            .then((info) => {
              const st = tagger.status();
              res.json({
                ...info,
                tagged: st.tagged,
                ...(st.browserUrl !== undefined ? { taggedBrowserUrl: st.browserUrl } : {}),
                ...(st.taggedAt !== undefined ? { taggedAt: st.taggedAt } : {}),
              });
            })
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
        viteRoot: join(here, ".."),
        distDir: join(here, "../assets/panel"),
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
          tagger.stop();
          cdp.dispose();
          await surface.dispose?.();
        },
      };
    },
  };
}
