/**
 * The **sidecar contract** — the seam between a session host and the extra
 * HTTP (and optional websocket) surfaces it serves alongside its own
 * endpoints, so one process serves one port. The sidecar packages in this
 * repo (the pencil surface, the remote bar) implement {@link Sidecar}; the
 * host that mounts them lives outside this repo. This module is the whole
 * agreement between the two sides, so neither needs the other to typecheck.
 *
 * The host stays generic: it mounts a sidecar's routes on its Express app,
 * offers it each websocket upgrade it doesn't handle itself, and disposes it
 * on shutdown — and never knows what the sidecar actually is. A test stands
 * up the same seam on a plain Express server (see aiui-pencil's sidecar test).
 *
 * A sidecar must confine itself to its own base path (e.g. everything under
 * `/pencil`), since the host's own routes are mounted first and must win. And
 * it must never write to stdout — a host whose stdout carries a protocol (an
 * MCP server's does) would be corrupted; use {@link SidecarContext.log}
 * (stderr).
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Express } from "express";

/** What the host hands a sidecar at mount time. */
export interface SidecarContext {
  /**
   * Whether the host is running from source (`"dev"`) or from an installed
   * build (`"prod"`). A web-serving sidecar uses it to choose a Vite dev
   * server (HMR, source-first) vs. serving a prebuilt static bundle — see
   * `serveClientSurface` in this package's `web-surface` entry. Sidecars with
   * no web surface can ignore it.
   */
  mode: "dev" | "prod";
  /** Log sink (stderr — the host's stdout may carry a protocol). */
  log: (message: string) => void;
  /**
   * The host's own bound port — LAZY, because sidecars mount just before
   * `listen` (the OS hasn't assigned it yet). `undefined` until listening.
   * This is how a sidecar addresses its own server (e.g. stamping the port
   * into a client it serves, or POSTing to a sibling route on the same host).
   */
  port: () => number | undefined;
}

/** The live handle a sidecar returns from {@link Sidecar.mount}. */
export interface MountedSidecar {
  /**
   * Offered each websocket upgrade the host didn't claim for its own
   * endpoints. Return `true` to take over the socket (the sidecar owns it from
   * then on), `false`/absent to let the host keep looking (and ultimately
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
   * Mount the sidecar's routes on the host's Express `app` (once, at startup)
   * and return its live handle. May be async — a sidecar that stands up a Vite
   * server or spawns a process does that work here.
   */
  mount(app: Express, ctx: SidecarContext): MountedSidecar | Promise<MountedSidecar>;
}
