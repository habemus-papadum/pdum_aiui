/**
 * Session **sidecars** — extra HTTP (and optional websocket) surfaces the
 * channel hosts alongside its own endpoints, so one session process serves one
 * port. The code reader is the first sidecar; a git viewer or another tool would
 * be the next.
 *
 * The channel stays generic: it mounts a sidecar's routes on its Express app,
 * offers it each websocket upgrade it doesn't handle itself, and disposes it on
 * shutdown — and never knows what the sidecar actually is. A sidecar is chosen
 * and constructed by the launcher (the `aiui` CLI decides which to run and hands
 * them to `startWebServer`); the channel package deliberately takes no
 * dependency on any concrete sidecar.
 *
 * A sidecar must confine itself to its own base path (e.g. everything under
 * `/code`), since the channel's own routes (`/health`, `/prompt`, and the `/ws`
 * `/tools` `/session` upgrades) are mounted first and must win. And like
 * everything in the web backend it must never write to stdout — use
 * {@link SidecarContext.log} (stderr).
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Express } from "express";

/** What the channel hands a sidecar at mount time. */
export interface SidecarContext {
  /** Log sink (stderr — the `mcp` command's stdout carries the MCP protocol). */
  log: (message: string) => void;
}

/** The live handle a sidecar returns from {@link Sidecar.mount}. */
export interface MountedSidecar {
  /**
   * Offered each websocket upgrade the channel didn't claim for its own
   * endpoints. Return `true` to take over the socket (the sidecar owns it from
   * then on), `false`/absent to let the channel keep looking (and ultimately
   * destroy an unclaimed upgrade).
   */
  handleUpgrade?(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  /** Release resources (spawned language servers, file watchers, a Vite server). */
  dispose?(): void | Promise<void>;
}

/** A mountable session sidecar (see the module doc). */
export interface Sidecar {
  /** Stable identifier for logging and CLI selection (e.g. `"code"`). */
  readonly name: string;
  /**
   * Mount the sidecar's routes on the channel's Express `app` (once, at startup)
   * and return its live handle. May be async — a sidecar that stands up a Vite
   * server or spawns a process does that work here.
   */
  mount(app: Express, ctx: SidecarContext): MountedSidecar | Promise<MountedSidecar>;
}
