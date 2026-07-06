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
 * The server runs with `debug: true` (surfaced on `/health`,
 * `/debug/api/info`, and every hello ack, so clients can tell), traces to the
 * project-local cache as usual, and — with `--record` — appends every
 * frame-log entry as JSONL under `.aiui-cache/recordings/` (see recording.ts).
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
import { createJsonlRecorder, type JsonlRecorder } from "../recording";
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

  const web = await startWebServer({
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
    // Names this run's trace session ("channel·…" when untagged), so /debug's
    // list separates a debug server's traces from a real session's.
    ...(options.tag !== undefined ? { tag: options.tag } : {}),
    ...(recorder !== undefined ? { frameSink: recorder.sink } : {}),
  });

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
