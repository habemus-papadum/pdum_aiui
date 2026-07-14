/**
 * The remote bar as a **channel sidecar** — how `aiui claude` hosts the bar
 * channel inside the live session: one {@link createBarBackend}, mounted on the
 * channel's own Express app under `/bar`, on the channel's one port. No separate
 * process, no separate listener, no separate port — the D5 "one sidecar per
 * control surface" pattern paint proved.
 *
 *  - The host page connects locally: it already knows the channel port
 *    (`window.__AIUI__.port`), so its host binding dials
 *    `ws://127.0.0.1:<channelPort>/bar/host` with zero extra discovery.
 *  - A bar-only remote (or the pencil iPad app) opens
 *    `ws://<this-machine>:<channelPort>/bar/client` — reachable when the channel
 *    binds the host interface (`channel.bind: "host"`), or through a tunnel the
 *    user owns when it stays loopback-only. Reachability is the CHANNEL's bind
 *    decision, not this sidecar's; the sidecar is cheap and always mounted (see
 *    docs/guide/warning.md for the posture, same as paint).
 *
 * `GET /bar/info` is the discovery route (readiness + counts, CORS for the
 * overlay's cross-origin capability probe). It, `/health`, and `/sessions` are
 * served by the backend under the prefix — this sidecar is a thin wrapper around
 * the backend's two seams.
 *
 * Unlike paint, there is **no HTML route**: the channel serves no pages, and the
 * bar's client is a frontend-process Solid component, not a page handed out by
 * the relay (paint's `/paint/` page is a documented exception for an iPad with no
 * frontend process; a bar remote is an ordinary app).
 */

import type { MountedSidecar, Sidecar, SidecarContext } from "@habemus-papadum/aiui-claude-channel";
import type { Express } from "express";
import { createBarBackend } from "./backend";

/** The path prefix the bar routes live under on the channel's server. */
export const BAR_PREFIX = "/bar";

export interface BarSidecarOptions {
  /** Project root, shown in the remote's session list. */
  root: string;
}

/** Package the remote bar as a channel {@link Sidecar}. */
export function barSidecar(options: BarSidecarOptions): Sidecar {
  return {
    name: "bar",
    mount(app: Express, ctx: SidecarContext): MountedSidecar {
      const backend = createBarBackend({
        prefix: BAR_PREFIX,
        session: { project: options.root },
        log: ctx.log,
      });

      app.use((req, res, next) => {
        if (!backend.handleHttp(req, res)) {
          next();
        }
      });
      ctx.log(`bar: mounted at ${BAR_PREFIX}/ on the channel port`);

      return {
        handleUpgrade: (req, socket, head) => backend.handleUpgrade(req, socket, head),
        dispose: () => {
          backend.dispose();
        },
      };
    },
  };
}
