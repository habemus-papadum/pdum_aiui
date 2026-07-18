/**
 * Session **sidecars** — extra HTTP (and optional websocket) surfaces the
 * channel hosts alongside its own endpoints, so one session process serves one
 * port. The concrete set today is the intent client, the remote bar, the iPad
 * pencil surface, and the console (see standard-sidecars.ts); a git viewer or
 * another tool would be the next.
 *
 * The channel stays generic: it mounts a sidecar's routes on its Express app,
 * offers it each websocket upgrade it doesn't handle itself, and disposes it on
 * shutdown — and never knows what the sidecar actually is. Callers hand live
 * {@link Sidecar} objects to `startWebServer`; by default the channel mounts
 * its own `standardSidecars` (the sidecar packages are published, so the
 * channel simply depends on them — see standard-sidecars.ts), and tests inject
 * their own set to stay hermetic.
 *
 * A sidecar must confine itself to its own base path (e.g. everything under
 * `/pencil`), since the channel's own routes (`/health`, `/prompt`, and the `/ws`
 * `/tools` `/session` upgrades) are mounted first and must win. And like
 * everything in the web backend it must never write to stdout — use
 * {@link SidecarContext.log} (stderr).
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Express } from "express";

/** What the channel hands a sidecar at mount time. */
export interface SidecarContext {
  /**
   * Whether the channel is running from source (`"dev"`) or from an installed
   * build (`"prod"`). Derived from whether the channel package itself is running
   * off `src/` (see the channel's `isSourceRun`), overridable via `--mode`. A
   * web-serving sidecar uses it to choose a Vite dev server (HMR, source-first)
   * vs. serving a prebuilt static bundle — see aiui-util's `serveClientSurface`.
   * Sidecars with no web surface can ignore it.
   */
  mode: "dev" | "prod";
  /** Log sink (stderr — the `mcp` command's stdout carries the MCP protocol). */
  log: (message: string) => void;
  /**
   * The channel's own bound port — LAZY, because sidecars mount just before
   * `listen` (the OS hasn't assigned it yet). `undefined` until listening.
   * This is how a sidecar addresses its own server (e.g. the intent sidecar's
   * CDP tagger stamping the channel port into the extension, or POSTing
   * `/prompt` to push a message into the Claude session).
   */
  port: () => number | undefined;
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
  /** Stable identifier for logging and CLI selection (e.g. `"pencil"`). */
  readonly name: string;
  /**
   * Mount the sidecar's routes on the channel's Express `app` (once, at startup)
   * and return its live handle. May be async — a sidecar that stands up a Vite
   * server or spawns a process does that work here.
   */
  mount(app: Express, ctx: SidecarContext): MountedSidecar | Promise<MountedSidecar>;
}
