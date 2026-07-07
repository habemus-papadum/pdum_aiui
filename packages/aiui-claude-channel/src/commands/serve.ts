/**
 * `aiui-claude-channel serve` — a standalone debug channel server that can
 * **never reach an agent**. For developing and testing clients (the web intent
 * tool, the workbench) against the real wire protocol, lowering pipeline, and
 * trace/debug tooling without a Claude Code session anywhere in the loop.
 *
 * The isolation is structural, not a flag check:
 *
 *  - **No MCP server, no stdio transport.** Unlike `mcp` (see mcp.ts), nothing
 *    here can emit a `notifications/claude/channel` — lowered prompts land on
 *    **stdout** as delimited blocks instead. There is no code path to a
 *    session.
 *  - **No `registerServer`.** A debug server must not pollute the shared
 *    registry that `aiui vite` / `quick` select real sessions from — if it
 *    did, a prompt meant for a session could be routed here (or a human could
 *    pick a server that answers to nobody). It is reachable only by its
 *    printed port.
 *
 * Everything else the real channel hosts is fair game — including session
 * sidecars (`--sidecars`, the same descriptor contract as `mcp`): a client
 * under development against this server (the workbench's code reader) needs
 * the sidecar's endpoints on the very channel port it is pointed at.
 *
 * The server runs with `debug: true` (surfaced on `/health`,
 * `/debug/api/info`, and every hello ack, so clients can tell), traces to the
 * project-local cache as usual, and — with `--record` — appends every
 * frame-log entry as JSONL under `.aiui-cache/recordings/` (see recording.ts).
 * It binds an OS-assigned loopback port unless `--port` pins one (the
 * workbench pins its channel to a fixed port so a human always knows where it
 * is); either way the ready line below carries the actual port, and a pinned
 * port that is already taken fails loudly instead of drifting.
 *
 * stdout protocol (stderr carries all progress/errors): the first line,
 * printed exactly once when the server is ready, is machine-parseable —
 *
 *   AIUI_CHANNEL_SERVE {"port":<n>,"pid":<n>,"debug":true}
 *
 * — and each lowered prompt then prints as
 *
 *   --- lowered prompt ---
 *   <the prompt text>
 *   --- meta ---            (only when the prompt carries attachment meta)
 *   <the meta, as JSON>
 *   --- end ---
 */

import { channelSourceDir, watchChannelSource } from "../hot";
import { loadSidecars, parseSidecarDescriptors } from "../load-sidecars";
import { createJsonlRecorder, type JsonlRecorder } from "../recording";
import type { Sidecar } from "../sidecar";
import { projectCacheDir } from "../trace";
import { startWebServer } from "../web";

export interface ServeOptions {
  /**
   * Label for stderr logging and the trace session label (see trace.ts's
   * `sessionLabel`) — a debug server is never registered.
   */
  tag?: string;
  /** Record every frame-log entry as JSONL under `<cache>/recordings/`. */
  record?: boolean;
  /**
   * Cache root for traces/recordings. Defaults to the project-local cache
   * (`.aiui-cache/` under the cwd); tests point it at a temp dir.
   */
  cacheDir?: string;
  /**
   * Fixed loopback port to bind (`--port`). Omitted, the OS assigns a free one
   * — the right default for anything discovered via the ready line or the
   * registry. A supervisor that promises its user a *known* address (the
   * workbench pins its channel to 49223) passes one; a taken port is then a
   * hard, explained failure instead of a silent drift (see {@link runServe}).
   */
  port?: number;
  /**
   * JSON array of session sidecar descriptors to host (`--sidecars`) — the
   * exact contract `mcp` accepts (see load-sidecars.ts). A debug server hosts
   * sidecars for the same reason the real one does: a client under development
   * (the workbench's code reader) needs the sidecar's endpoints on the channel
   * port it is pointed at. Parse and load are best-effort — a bad value or one
   * failing descriptor is logged to stderr and skipped, never fatal.
   */
  sidecars?: string;
}

/**
 * Parse a `--port` value: an integer in [1, 65535], strictly decimal (no
 * `0x10`, no floats, no empty string — `Number()` alone is too forgiving for a
 * CLI flag). Throws with a human-readable message; the CLI layer (program.ts)
 * re-wraps it as a commander `InvalidArgumentError` so usage errors render as
 * usage errors.
 */
export function parsePort(value: string): number {
  const port = /^\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`expected an integer between 1 and 65535, got "${value}"`);
  }
  return port;
}

/** The running debug server, for tests (the CLI just lets it run). */
export interface ServeHandle {
  /** The loopback port the server bound to. */
  port: number;
  /** Stop the server (and flush the recording, when one is on). Idempotent. */
  close(): Promise<void>;
}

/** Run the standalone debug channel server until a signal (or `close()`). */
export async function runServe(options: ServeOptions = {}): Promise<ServeHandle> {
  const cacheDir = options.cacheDir ?? projectCacheDir();

  let recorder: JsonlRecorder | undefined;
  if (options.record === true) {
    recorder = createJsonlRecorder(cacheDir);
    process.stderr.write(`[aiui-channel serve] recording frames to ${recorder.path}\n`);
  }

  // Resolve the supervisor's sidecar descriptors into live sidecars, exactly
  // like `mcp` does (load-sidecars.ts logs failures to stderr — stdout stays
  // the ready-line + lowered-prompt protocol).
  let sidecars: Sidecar[] | undefined;
  if (options.sidecars !== undefined) {
    sidecars = await loadSidecars(parseSidecarDescriptors(options.sidecars));
  }

  let web: Awaited<ReturnType<typeof startWebServer>>;
  try {
    web = await startWebServer({
      // The whole point: the "session" is stdout. The delimiters make the block
      // easy to spot in a scrollback and easy to slice in a script.
      onPrompt: (text, meta) => {
        const lines = ["--- lowered prompt ---", text];
        if (meta !== undefined) {
          lines.push("--- meta ---", JSON.stringify(meta, null, 2));
        }
        lines.push("--- end ---");
        process.stdout.write(`${lines.join("\n")}\n`);
      },
      traceDir: cacheDir,
      debug: true,
      sidecars,
      // Names this run's trace session ("channel·…" when untagged), so /debug's
      // list separates a debug server's traces from a real session's.
      ...(options.tag !== undefined ? { tag: options.tag } : {}),
      ...(recorder !== undefined ? { frameSink: recorder.sink } : {}),
      ...(options.port !== undefined ? { port: options.port } : {}),
    });
  } catch (error) {
    await recorder?.close();
    // A fixed port exists to be predictable, so a collision must explain
    // itself — the raw EADDRINUSE stack says which port but not what to do.
    if (
      options.port !== undefined &&
      (error as NodeJS.ErrnoException | undefined)?.code === "EADDRINUSE"
    ) {
      throw new Error(
        `port ${options.port} is already in use — is another \`serve\` (or a workbench, ` +
          "which spawns one) still running? Stop it, or pass a different --port.",
      );
    }
    throw error;
  }

  // The same dev auto-reload `mcp` has (AIUI_CHANNEL_WATCH=1, source checkout
  // only): edit the lowering code and the format registry hot-rebuilds — open
  // sockets drop with 1012 and the next turn runs the new code. The workbench
  // spawns serve with the flag set, so pipeline edits apply without a restart.
  // POST /debug/api/reload remains the always-on manual trigger.
  let stopWatch: (() => void) | undefined;
  if (process.env.AIUI_CHANNEL_WATCH === "1") {
    const srcDir = channelSourceDir();
    if (srcDir) {
      stopWatch = watchChannelSource({
        dir: srcDir,
        onChange: () => {
          web
            .reload()
            .then((s) =>
              process.stderr.write(
                `[aiui-channel serve] reloaded on edit — generation=${s.generation} socketsDropped=${s.socketsDropped}\n`,
              ),
            )
            .catch((err) =>
              process.stderr.write(
                `[aiui-channel serve] reload failed: ${err instanceof Error ? err.message : String(err)}\n`,
              ),
            );
        },
      });
      process.stderr.write(
        `[aiui-channel serve] watching ${srcDir} for edits (AIUI_CHANNEL_WATCH=1)\n`,
      );
    } else {
      process.stderr.write(
        "[aiui-channel serve] AIUI_CHANNEL_WATCH=1 ignored — not running from source\n",
      );
    }
  }

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    stopWatch?.();
    await web.close().catch(() => {});
    await recorder?.close();
  };
  // `once`, not `on`: after our graceful pass the default handler is back, so
  // a second Ctrl-C during a wedged shutdown still kills the process.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      process.stderr.write(`[aiui-channel serve] ${signal} — shutting down\n`);
      void close().finally(() => process.exit(0));
    });
  }

  // The ready line: first on stdout, exactly once, machine-parseable. Nothing
  // can beat it there — prompts only flow once a client connects to the port
  // this very line announces.
  process.stdout.write(
    `AIUI_CHANNEL_SERVE ${JSON.stringify({ port: web.port, pid: process.pid, debug: true })}\n`,
  );
  process.stderr.write(
    `[aiui-channel serve] up — ${options.tag !== undefined ? `tag=${options.tag} ` : ""}` +
      `pid=${process.pid} port=${web.port} cache=${cacheDir} ` +
      "(debug: not registered, no MCP — prompts print to stdout)\n",
  );

  return { port: web.port, close };
}
