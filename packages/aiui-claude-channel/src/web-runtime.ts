/**
 * The channel server's shared-mutable-state cluster, made an explicit context
 * object. `reload`, the upgrade router, all three connection handlers, sidecar
 * mounting, `/health`, and `/debug` all read and write this one cluster —
 * {generation, formats, liveSockets, mountedSidecars, boundPort} — so it lives
 * here as {@link ChannelRuntime} rather than as closure-shared bindings in
 * `startWebServer`.
 *
 * Two fields are load-bearing seams and must be used as documented:
 *  - `getFormats()` is a GETTER — connection handlers call it per-connection so a
 *    socket opened after a reload speaks the freshly-loaded layer. Capturing the
 *    registry at attach time silently freezes hot-reload.
 *  - `mountedSidecars` is passed BY REFERENCE: the upgrade router iterates it, and
 *    the mount loop populates it AFTER the router is attached. Snapshotting it
 *    (spread/slice) breaks every sidecar websocket.
 */
import type { WebSocket } from "ws";
import type { FormatRegistry } from "./channel";
import type { FormatLoader } from "./hot";
import type { MountedSidecar } from "./sidecar";
import type { TraceStore } from "./trace";
import { withTracing } from "./tracing";
import type { ReloadSummary } from "./web";

export const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

export interface ChannelRuntime {
  /** The current reload generation (0 at startup, +1 per successful reload). */
  getGeneration(): number;
  /**
   * The registry new connections read. A GETTER read per-connection — never
   * captured at attach time, or a reload silently stops delivering fresh code.
   */
  getFormats(): FormatRegistry;
  /**
   * Reload the lowering layer in place. Order matters for robustness: build the
   * fresh registry FIRST — if the freshly edited code throws, reject here and
   * leave the running server, its sockets, and the old registry untouched. Only
   * once the rebuild succeeds do we swap the registry, bump the generation, and
   * drop live sockets (each runs its normal close path; clients reconnect).
   */
  reload(): Promise<ReloadSummary>;
  /** Every live socket (all endpoints), so reload can drop them all. */
  liveSockets: Set<WebSocket>;
  /**
   * Session sidecars mounted alongside the channel. The SAME mutable array the
   * upgrade router iterates and the mount loop pushes into — held by reference,
   * never snapshotted.
   */
  mountedSidecars: MountedSidecar[];
  /** The bound port, resolved only after `listen` — handed to sidecars as a thunk. */
  getBoundPort(): number | undefined;
  /** Backfill the bound port once `listen` resolves. */
  setBoundPort(port: number): void;
}

/**
 * Build the channel runtime, performing the initial format load eagerly so a
 * broken lowering layer fails fast at startup (the same fail-fast as the first
 * `buildFormats(0)` did inline).
 */
export async function createChannelRuntime(deps: {
  loadFormats: FormatLoader;
  traceStore?: TraceStore;
}): Promise<ChannelRuntime> {
  const { loadFormats, traceStore } = deps;

  // Bumps on every successful reload; surfaced on /health and /debug/api/info so
  // a page or panel can tell it's talking to freshly-reloaded code.
  let generation = 0;
  // Every live socket (both endpoints), so reload can drop them all. Tracked
  // explicitly rather than via `wss.clients` because the `noServer` upgrade path
  // makes that set's membership less obvious to reason about.
  const liveSockets = new Set<WebSocket>();
  // Populated by the sidecar mount loop (after the upgrade router is attached)
  // and read by the upgrade handler; deliberately shared mutable state.
  const mountedSidecars: MountedSidecar[] = [];
  let boundPort: number | undefined;

  // Rebuild the live registry for a generation: load the base formats, then
  // re-wrap tracing (a fresh wrap over the same singleton store).
  const buildFormats = async (gen: number): Promise<FormatRegistry> => {
    const base = await loadFormats(gen);
    return traceStore ? withTracing(base, traceStore) : base;
  };

  // The registry new connections read. Reassigned on reload; existing (dropped)
  // connections captured the old one.
  let formats = await buildFormats(generation);

  const reload = async (): Promise<ReloadSummary> => {
    const next = await buildFormats(generation + 1);
    generation += 1;
    formats = next;
    const dropping = [...liveSockets];
    liveSockets.clear();
    for (const socket of dropping) {
      try {
        // 1012 = "service restart": the standards-registered code for exactly this.
        socket.close(1012, "channel reload");
      } catch {
        // A socket already closing/closed just gets skipped.
      }
    }
    return { reloaded: true, generation, socketsDropped: dropping.length };
  };

  return {
    getGeneration: () => generation,
    getFormats: () => formats,
    reload,
    liveSockets,
    mountedSidecars,
    getBoundPort: () => boundPort,
    setBoundPort: (port: number) => {
      boundPort = port;
    },
  };
}
