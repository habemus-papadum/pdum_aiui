/**
 * The paint stream as a **channel sidecar** — how `aiui claude` hosts the iPad
 * paint stream inside the live session, with no separate relay process.
 *
 * Two faces, one {@link createPaintBackend} room state:
 *
 *  - **loopback face** (the channel's own Express app, under `/paint`): where
 *    the desktop browser connects. The app page already knows the channel port
 *    (`window.__AIUI__.port`), so the overlay's paint host dials
 *    `ws://127.0.0.1:<channelPort>/paint/host` with zero extra discovery. Also
 *    serves `GET /paint/info` — the discovery route `aiui paint url` reads to
 *    print the iPad URL.
 *  - **LAN face** (an extra listener this sidecar owns): where the iPad
 *    connects — an iPad cannot reach the channel's loopback-only port. It
 *    serves the same backend (client page at `/paint/`, plus a bare `/` →
 *    `/paint/` redirect so a hand-typed URL works). The channel's own server
 *    stays loopback-only; ONLY the paint surface is exposed, and only when this
 *    sidecar was explicitly enabled (`aiui claude --aiui-sidecar paint`).
 *
 * SECURITY: the LAN face is unauthenticated by design (a personal, trusted
 * network — see docs/guide/warning.md). That is why the paint sidecar is
 * opt-in, never auto-enabled.
 */
import { createServer, type Server } from "node:http";
import { networkInterfaces } from "node:os";
import type { MountedSidecar, Sidecar, SidecarContext } from "@habemus-papadum/aiui-claude-channel";
import type { Express } from "express";
import { createPaintBackend } from "./backend";

/** The LAN face's preferred port; falls back to an OS-assigned one when taken
 * (a second session). Chosen outside the usual dev-server range. */
export const DEFAULT_PAINT_LAN_PORT = 8788;

/** The path prefix the paint routes live under, on both faces. */
export const PAINT_PREFIX = "/paint";

export interface PaintSidecarOptions {
  /** Project root, shown in the iPad's session list. */
  root: string;
  /** LAN face port. Default {@link DEFAULT_PAINT_LAN_PORT}, falling back to
   * OS-assigned when busy; `0` for always-OS-assigned. */
  lanPort?: number;
  /** LAN bind address. Default `0.0.0.0`. */
  lanHost?: string;
}

/** What `GET /paint/info` reports (read by `aiui paint url`). */
export interface PaintInfo {
  ok: true;
  /** The LAN face, or undefined when it failed to bind. */
  lan?: { port: number; urls: string[] };
  hosts: number;
  clients: number;
}

/** Non-internal IPv4 addresses — the URLs an iPad on the LAN can open. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === "IPv4" && !addr.internal) {
        out.push(addr.address);
      }
    }
  }
  return out;
}

/** Package the paint stream as a channel {@link Sidecar}. */
export function paintSidecar(options: PaintSidecarOptions): Sidecar {
  return {
    name: "paint",
    async mount(app: Express, ctx: SidecarContext): Promise<MountedSidecar> {
      const backend = createPaintBackend({
        prefix: PAINT_PREFIX,
        session: { project: options.root },
        log: ctx.log,
      });

      // ── LAN face: the iPad's entrance ─────────────────────────────────────
      const lanServer: Server = createServer((req, res) => {
        if (req.url === "/" || req.url === "") {
          // A hand-typed http://<ip>:<port>/ lands on the client page.
          res.statusCode = 302;
          res.setHeader("Location", `${PAINT_PREFIX}/`);
          res.end();
          return;
        }
        if (req.url?.startsWith(`${PAINT_PREFIX}/info`)) {
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(info()));
          return;
        }
        if (!backend.handleHttp(req, res)) {
          res.statusCode = 404;
          res.end("not found");
        }
      });
      lanServer.on("upgrade", (req, socket, head) => {
        if (!backend.handleUpgrade(req, socket, head)) {
          socket.destroy();
        }
      });

      const lanHost = options.lanHost ?? "0.0.0.0";
      const preferred = options.lanPort ?? DEFAULT_PAINT_LAN_PORT;
      const listen = (port: number): Promise<number | undefined> =>
        new Promise((resolve) => {
          const onError = (err: NodeJS.ErrnoException): void => {
            lanServer.removeListener("error", onError);
            ctx.log(`paint: LAN listener failed on port ${port} (${err.code ?? err.message})`);
            resolve(undefined);
          };
          lanServer.once("error", onError);
          lanServer.listen(port, lanHost, () => {
            lanServer.removeListener("error", onError);
            const address = lanServer.address();
            resolve(typeof address === "object" && address !== null ? address.port : port);
          });
        });
      // Prefer the well-known port; a second session falls back to an
      // OS-assigned one (`aiui paint url` reports whichever it got).
      let lanPort = await listen(preferred);
      if (lanPort === undefined && preferred !== 0) {
        lanPort = await listen(0);
      }
      if (lanPort !== undefined) {
        ctx.log(
          `paint: iPad client on the LAN at http://<this-machine>:${lanPort}${PAINT_PREFIX}/ (run \`aiui paint url\`)`,
        );
      }

      const info = (): PaintInfo => ({
        ok: true,
        ...(lanPort !== undefined
          ? {
              lan: {
                port: lanPort,
                urls: lanAddresses().map((ip) => `http://${ip}:${lanPort}${PAINT_PREFIX}/`),
              },
            }
          : {}),
        ...backend.counts(),
      });

      // ── loopback face: mounted on the channel's Express app ───────────────
      app.use((req, res, next) => {
        if (req.url?.startsWith(`${PAINT_PREFIX}/info`)) {
          // Discovery for `aiui paint url` and the overlay's capability probe.
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.json(info());
          return;
        }
        if (!backend.handleHttp(req, res)) {
          next();
        }
      });

      return {
        handleUpgrade: (req, socket, head) => backend.handleUpgrade(req, socket, head),
        dispose: async () => {
          backend.dispose();
          await new Promise<void>((resolve) => {
            lanServer.close(() => resolve());
            // close() waits for idle keep-alive sockets; don't.
            lanServer.closeAllConnections?.();
          });
        },
      };
    },
  };
}
