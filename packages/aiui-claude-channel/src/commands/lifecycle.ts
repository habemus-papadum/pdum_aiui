/**
 * Shared process-lifecycle scaffolding for the two channel server twins — the
 * real MCP channel (mcp.ts) and the agent-less debug channel (serve.ts). Both
 * host the same registry/web/staleness/shutdown lifecycle around different
 * session seams (stdio MCP notifications vs a stdout delimited protocol), so the
 * pieces that are genuinely identical live here as small, composable helpers.
 *
 * Package-internal by design: both consumers are in this package, so nothing is
 * re-exported from the barrel. The seam is kept deliberately fine-grained —
 * signal wiring is NOT here (mcp uses `process.on` + SIGHUP + `mcp.onclose`,
 * serve uses `process.once` so a second Ctrl-C during a wedged shutdown hits the
 * default handler), and the twin-specific reactions to a stale source or a
 * shutdown ride in as caller-supplied callbacks/thunks so each twin's exact
 * ordering and per-closer error policy survive verbatim.
 */

import type { ChannelLog } from "../channel-log";
import { channelSourceDir, watchChannelSource } from "../hot";
import type { RegisteredServer } from "../registry";
import type { Sidecar } from "../sidecar";
import { standardSidecars } from "../standard-sidecars";

/** The options both channel servers share (mcp's and serve's extend it). */
export interface CommonChannelOptions {
  /**
   * Tag identifying this channel session — the registry address (defaults to a
   * fresh UUID), which also doubles as the stderr-logging and trace-session
   * label (see trace.ts's `sessionLabel`). Pass one (e.g. from a test harness)
   * to make the server addressable by a known value.
   */
  tag?: string;
  /**
   * The sidecars to host, as live {@link Sidecar} objects. Defaults to
   * {@link standardSidecars} (intent, bar, pencil, console — the channel imports
   * and composes them itself now that they are published; see
   * standard-sidecars.ts): a debug server hosts the same set the real one does,
   * so a client under development finds the sidecar's endpoints on the very
   * channel port it is pointed at. Tests pass their own set (often `[]`) to stay
   * hermetic. A sidecar whose `mount` throws is isolated by `startWebServer`.
   */
  sidecars?: Sidecar[];
  /**
   * Where the web backend binds: `"loopback"` (127.0.0.1, the default) or
   * `"host"` (0.0.0.0 — the trusted-LAN posture: every unauthenticated channel
   * route, sidecars included, becomes reachable from the network; the launcher
   * or supervisor only passes this on the user's explicit `channel.bind` /
   * `--aiui-bind` choice, the same knob a real `aiui claude` launch obeys). See
   * docs/guide/warning.md.
   */
  bind?: "loopback" | "host";
  /**
   * Force the sidecars' dev/prod mode (`--mode`). Omitted, the channel derives
   * it from whether it is running off `src/` (see `startWebServer`); pass it to
   * exercise the prod static-serving path from a source checkout — the debug
   * server is the natural place to do so.
   */
  mode?: "dev" | "prod";
}

/**
 * The sidecars to host: the caller's set, or the channel's standard set rooted
 * at this process's cwd (which the launcher sets to the project root). Tests
 * inject their own to stay hermetic.
 */
export function resolveSidecars(opts: CommonChannelOptions): Sidecar[] {
  return opts.sidecars ?? standardSidecars(process.cwd());
}

/**
 * The three conditional {@link startWebServer} options both twins compute the
 * same way: the forced `mode` (when set), `host: "0.0.0.0"` iff `bind === "host"`,
 * and the *explicit* `--tag` only. The minted-UUID tag is a registry address,
 * not a human label — passing it through would misname the trace session, which
 * an untagged server labels as "channel·<pid>·<HHMMSS>" (see `sessionLabel`).
 */
export function commonWebOptions(opts: CommonChannelOptions): {
  mode?: "dev" | "prod";
  host?: string;
  tag?: string;
} {
  return {
    ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
    ...(opts.bind === "host" ? { host: "0.0.0.0" } : {}),
    ...(opts.tag !== undefined ? { tag: opts.tag } : {}),
  };
}

/**
 * Start the dev-only staleness watch, opt-in via `AIUI_CHANNEL_WATCH=1` and only
 * meaningful in a source checkout (a packaged install has nothing on disk to
 * watch). The channel does NOT hot-reload — instead, when its own backend source
 * changes, the twin reacts via `onStale` (mcp pushes a notice into the session,
 * serve narrates to stderr). This helper owns the env gate, the source-dir
 * lookup, the watcher, and the two lifecycle stderr lines; the reaction stays in
 * the caller's `onStale`. Returns a disposer, or `undefined` when the watch is
 * off or there is no source to watch.
 */
export function startStalenessWatch({
  logPrefix,
  onStale,
}: {
  logPrefix: string;
  onStale: () => void;
}): (() => void) | undefined {
  if (process.env.AIUI_CHANNEL_WATCH !== "1") {
    return undefined;
  }
  const srcDir = channelSourceDir();
  if (!srcDir) {
    process.stderr.write(`${logPrefix} AIUI_CHANNEL_WATCH=1 ignored — not running from source\n`);
    return undefined;
  }
  const stopWatch = watchChannelSource({ dir: srcDir, onChange: onStale });
  process.stderr.write(`${logPrefix} watching ${srcDir} for staleness (AIUI_CHANNEL_WATCH=1)\n`);
  return stopWatch;
}

/** A cleanup thunk run during shutdown; may be async, may be `undefined` (e.g. an unset watcher). */
type Closer = (() => unknown | Promise<unknown>) | undefined;

/**
 * Build the idempotent shutdown routine both twins share the skeleton of: mark
 * shutting-down, log it, remove the registry entry, then await the
 * caller-ordered `closers`, and finally close the diagnostic log — always last,
 * so it records the shutdown it is closing over.
 *
 * `closers` are raw twin-supplied thunks so each twin's exact ordering AND
 * per-closer error policy survive verbatim: mcp swallows both its web and mcp
 * closes, serve swallows only its web close (its recorder and this log close
 * unswallowed). The helper never normalizes this — a unified error policy would
 * be a behavior change (which close silently tolerates a failure differs by
 * design). `undefined` closers (an unset staleness watcher) are skipped.
 */
export function createShutdown({
  channelLog,
  registration,
  closers,
}: {
  channelLog: ChannelLog;
  registration: RegisteredServer;
  closers: Closer[];
}): () => Promise<void> {
  let shuttingDown = false;
  return async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    channelLog.log("shutdown");
    registration.remove();
    for (const closer of closers) {
      await closer?.();
    }
    await channelLog.close();
  };
}

/**
 * Last-resort cleanup: unlink the registry file on plain process `exit`. The
 * synchronous `exit` handler can't await, so it only does this one thing;
 * `remove()` is race-safe and idempotent, so overlapping with a graceful
 * shutdown is fine. `exit` fires at most once, so `once` matches its semantics.
 */
export function installExitBackstop(registration: RegisteredServer): void {
  process.once("exit", () => {
    registration.remove();
  });
}
