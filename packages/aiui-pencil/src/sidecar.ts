/**
 * The remote pencil as a **channel sidecar** — one {@link createPencilBackend},
 * mounted on the channel's own Express app under `/pencil`, on the channel's one
 * port. No separate process, no separate listener, no separate port — the same
 * pattern as `/paint` (which this replaces) and `/bar` (D5's sibling channel).
 *
 *  - The host page connects locally: it already knows the channel port
 *    (`window.__AIUI__.port`), so it dials `ws://127.0.0.1:<port>/pencil/host`
 *    with zero extra discovery.
 *  - The iPad opens `ws://<this-machine>:<port>/pencil/client` — reachable when
 *    the channel binds the host interface (`channel.bind: "host"`), or through a
 *    tunnel the user owns when it stays loopback-only. Reachability is the
 *    CHANNEL's bind decision, not this sidecar's (docs/guide/warning.md).
 *
 * **The relay carries no media** (D1): video is a peer-to-peer WebRTC track, and
 * this socket moves ink intent and signaling — a few JSON frames a second.
 *
 * One HTML route, deliberately: `GET /pencil/` serves the client app (paint's
 * iPad exception — an iPad has no frontend process). HOW it is served is a
 * {@link SidecarContext.mode} decision, delegated to the shared helper
 * (aiui-util's `serveClientSurface`): in DEV a Vite dev server in middleware
 * mode over the lab client sources (HMR riding the channel's one port); in PROD
 * the prebuilt `assets/client` bundle (built by `build:client`). Everything else
 * on this prefix stays JSON/websocket.
 */

import { fileURLToPath } from "node:url";
import type { MountedSidecar, Sidecar, SidecarContext } from "@habemus-papadum/aiui-claude-channel";
import { serveClientSurface } from "@habemus-papadum/aiui-util/web-surface";
import type { Express } from "express";
import { createPencilBackend } from "./backend";
import { defaultClientDir } from "./client-static";

/** The path prefix the pencil routes live under on the channel's server. */
export const PENCIL_PREFIX = "/pencil";

export interface PencilSidecarOptions {
  /** Project root, shown in the client's session list. */
  root: string;
  /** Override where the built client is served from (tests). */
  clientDir?: string;
}

/** Package the remote pencil as a channel {@link Sidecar}. */
export function pencilSidecar(options: PencilSidecarOptions): Sidecar {
  return {
    name: "pencil",
    async mount(app: Express, ctx: SidecarContext): Promise<MountedSidecar> {
      const backend = createPencilBackend({
        prefix: PENCIL_PREFIX,
        session: { project: options.root },
        log: ctx.log,
      });
      // The backend's JSON routes (`/pencil/info`, `/health`, `/sessions`) go on
      // FIRST, so they win over the client middleware `serveClientSurface` adds
      // for `/pencil/` and its assets.
      app.use((req, res, next) => {
        if (!backend.handleHttp(req, res)) {
          next();
        }
      });

      // The iPad's page (`GET /pencil/`), served per mode. Dev roots Vite at
      // `client/` (the kit's paved-road composition; solid, no lab rig) and
      // serves its `index.html` at the base; prod serves the `assets/client`
      // bundle that same config builds.
      const surface = await serveClientSurface(app, {
        mode: ctx.mode,
        prefix: PENCIL_PREFIX,
        viteRoot: fileURLToPath(new URL("../client", import.meta.url)),
        viteConfigFile: fileURLToPath(new URL("../client/vite.config.ts", import.meta.url)),
        devEntry: "index.html",
        distDir: options.clientDir ?? defaultClientDir(),
        notBuiltHint: "pnpm -C packages/aiui-pencil build:client",
        log: ctx.log,
      });
      ctx.log(`pencil: mounted at ${PENCIL_PREFIX}/ on the channel port`);

      return {
        // The surface claims its HMR socket (dev only); the host/client sockets
        // are the backend's.
        handleUpgrade: (req, socket, head) =>
          surface.handleUpgrade?.(req, socket, head) === true ||
          backend.handleUpgrade(req, socket, head),
        dispose: async () => {
          backend.dispose();
          await surface.dispose?.();
        },
      };
    },
  };
}
