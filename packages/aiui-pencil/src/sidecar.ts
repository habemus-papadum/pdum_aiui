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
 * One HTML route, deliberately: `GET /pencil/` serves the **built client app**
 * (paint's iPad exception — an iPad has no frontend process). Everything else
 * on this prefix stays JSON/websocket.
 */

import type { MountedSidecar, Sidecar, SidecarContext } from "@habemus-papadum/aiui-claude-channel";
import type { Express } from "express";
import { createPencilBackend } from "./backend";
import { clientStatic } from "./client-static";

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
    mount(app: Express, ctx: SidecarContext): MountedSidecar {
      const backend = createPencilBackend({
        prefix: PENCIL_PREFIX,
        session: { project: options.root },
        log: ctx.log,
      });
      // The iPad's page: `GET /pencil/` serves the BUILT client app — the one
      // page-serving exception (an iPad has no frontend process), inherited
      // from paint. JSON routes are checked first so `/pencil/info` and
      // friends never fall through to the static handler.
      const page = clientStatic(PENCIL_PREFIX, options.clientDir);

      app.use((req, res, next) => {
        if (!backend.handleHttp(req, res) && !page.handle(req, res)) {
          next();
        }
      });
      ctx.log(`pencil: mounted at ${PENCIL_PREFIX}/ on the channel port`);

      return {
        handleUpgrade: (req, socket, head) => backend.handleUpgrade(req, socket, head),
        dispose: () => {
          backend.dispose();
        },
      };
    },
  };
}
