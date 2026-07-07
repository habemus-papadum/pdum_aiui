/**
 * The paint stream as a **channel sidecar** — how `aiui claude` hosts the iPad
 * paint stream inside the live session: one {@link createPaintBackend}, mounted
 * on the channel's own Express app under `/paint`, on the channel's one port.
 * No separate process, no separate listener, no separate port.
 *
 *  - The desktop browser connects locally: the app page already knows the
 *    channel port (`window.__AIUI__.port`), so the overlay's paint host dials
 *    `ws://127.0.0.1:<channelPort>/paint/host` with zero extra discovery.
 *  - The iPad opens `http://<this-machine>:<channelPort>/paint/` — reachable
 *    when the channel binds the host interface (`channel.bind: "host"` /
 *    `aiui claude --aiui-bind host`), or through a tunnel the user owns
 *    (Tailscale, `ssh -L`) when the channel stays loopback-only. Reachability
 *    is the CHANNEL's bind decision, not this sidecar's; the sidecar itself is
 *    cheap and always mounted (see docs/guide/warning.md for the posture).
 *
 * `GET /paint/info` is the discovery route: the overlay's capability probe
 * reads it before dialing, and `aiui paint url` combines it with the channel
 * registry (port) and `/health` (bind) to print the URL to open on the iPad.
 */
import type { MountedSidecar, Sidecar, SidecarContext } from "@habemus-papadum/aiui-claude-channel";
import type { Express } from "express";
import { createPaintBackend } from "./backend";

/** The path prefix the paint routes live under on the channel's server. */
export const PAINT_PREFIX = "/paint";

export interface PaintSidecarOptions {
  /** Project root, shown in the iPad's session list. */
  root: string;
}

/** What `GET /paint/info` reports (read by the overlay probe and `aiui paint url`). */
export interface PaintInfo {
  ok: true;
  hosts: number;
  clients: number;
}

/** Package the paint stream as a channel {@link Sidecar}. */
export function paintSidecar(options: PaintSidecarOptions): Sidecar {
  return {
    name: "paint",
    mount(app: Express, ctx: SidecarContext): MountedSidecar {
      const backend = createPaintBackend({
        prefix: PAINT_PREFIX,
        session: { project: options.root },
        log: ctx.log,
      });

      app.use((req, res, next) => {
        if (req.url?.startsWith(`${PAINT_PREFIX}/info`)) {
          // Discovery for `aiui paint url` and the overlay's capability probe
          // (which runs from the app dev server's origin — hence the CORS).
          res.setHeader("Access-Control-Allow-Origin", "*");
          const info: PaintInfo = { ok: true, ...backend.counts() };
          res.json(info);
          return;
        }
        if (!backend.handleHttp(req, res)) {
          next();
        }
      });
      ctx.log(
        `paint: mounted at ${PAINT_PREFIX}/ on the channel port (run \`aiui paint url\` for the iPad URL)`,
      );

      return {
        handleUpgrade: (req, socket, head) => backend.handleUpgrade(req, socket, head),
        dispose: () => {
          backend.dispose();
        },
      };
    },
  };
}
