import { randomUUID } from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createChannelLog } from "../channel-log";
import { channelSourceDir, watchChannelSource } from "../hot";
import { type LaunchInfo, parseLaunchInfo } from "../launch-info";
import { loadSidecars, parseSidecarDescriptors } from "../load-sidecars";
import { formatPageToolsChanged, PageToolDirectory } from "../page-tools";
import { registerServer } from "../registry";
import { createChannelServer } from "../server";
import type { Sidecar } from "../sidecar";
import { projectCacheDir } from "../trace";
import { startWebServer, type WebServer } from "../web";

export interface McpOptions {
  /**
   * Tag identifying this channel session. Defaults to a fresh UUID; pass one
   * (e.g. from a test harness) to make the server addressable by a known value.
   */
  tag?: string;
  /**
   * JSON launch summary from the launcher (`aiui claude`) — how the session's
   * Chrome DevTools MCP was wired, etc. Parsed tolerantly (it's diagnostics,
   * not behavior) and surfaced at `GET /debug/api/info`. See launch-info.ts.
   */
  launchInfo?: string;
  /**
   * JSON array of session sidecar descriptors the launcher wants this channel to
   * host (see load-sidecars.ts). Each is dynamic-imported and constructed, then
   * passed to `startWebServer({ sidecars })`. The channel takes no dependency on
   * any concrete sidecar — the descriptor's `module` string is the caller's. A
   * descriptor that fails to load is logged to stderr and skipped, never fatal.
   */
  sidecars?: string;
  /**
   * Where the web backend binds: `"loopback"` (127.0.0.1, the default) or
   * `"host"` (0.0.0.0 — the trusted-LAN posture: every unauthenticated channel
   * route, sidecars included, becomes reachable from the network; the launcher
   * only passes this on the user's explicit `channel.bind` / `--aiui-bind`
   * choice). See docs/guide/warning.md.
   */
  bind?: "loopback" | "host";
  /**
   * Push a terse "page tools changed: ns/name, …" note into the session when
   * the page-tool directory changes — rung 2 of the notification ladder
   * (docs/proposals/browser-extension-intent-tool.md §7). Named tools ride the
   * push because a *listed* tool is not necessarily one the model looks up
   * (archive/extension-spikes/RESULTS.md, M3). Defaults ON (`false` disables;
   * the CLI's `--no-page-tools-notify`). The spec-blessed
   * `notifications/tools/list_changed` (rung 3) is sent regardless.
   */
  pageToolsNotify?: boolean;
}

// Injected at build time by Vite's `define` (see vite.config.ts). The `typeof`
// guard is a no-op in the built CLI (where the define replaces it with a string
// literal) but keeps this working anywhere the define isn't applied.
declare const __AIUI_CHANNEL_VERSION__: string;
const VERSION =
  typeof __AIUI_CHANNEL_VERSION__ === "string" ? __AIUI_CHANNEL_VERSION__ : "0.0.0+dev";

/**
 * Launch the aiui channel MCP server over stdio.
 *
 * This is the process Claude Code spawns as a subprocess. On startup it:
 *  1. connects the stdio transport (completing the session handshake),
 *  2. starts a loopback web backend (POST /prompt, GET /health, and the /ws
 *     stream-processor websocket) that forwards text into the session over
 *     the channel, and
 *  3. advertises itself in the shared cache registry (tag, pid, parent pid,
 *     port, cwd) so tools like `quick` can find it.
 *
 * It then stays alive (the stdio transport keeps reading stdin). On the way out
 * — a signal, Claude Code disconnecting, or plain process exit — it removes its
 * registry file as reliably as it can, so stale entries are the exception (and
 * {@link listMcpServers} prunes those it misses).
 */
export async function runMcp(options: McpOptions = {}): Promise<void> {
  const tag = options.tag ?? randomUUID();
  let launchInfo: LaunchInfo | undefined;
  if (options.launchInfo !== undefined) {
    launchInfo = parseLaunchInfo(options.launchInfo);
    if (!launchInfo) {
      // Diagnostics only — a bad value must never stop the server.
      process.stderr.write("[aiui-channel] ignoring malformed --launch-info JSON\n");
    }
  }
  // Resolve the launcher's sidecar descriptors into live sidecars. Both the
  // parse and each load are best-effort (see load-sidecars.ts): a malformed
  // value or one bad descriptor is logged to stderr and skipped, never fatal, so
  // this can't stop the server from coming up. Stays generic — the channel
  // dynamic-imports whatever `module` specifiers it's handed.
  let sidecars: Sidecar[] | undefined;
  if (options.sidecars !== undefined) {
    sidecars = await loadSidecars(parseSidecarDescriptors(options.sidecars));
  }
  // The page-tool registry is shared by the MCP tools (which read and drive it)
  // and the `/tools` websocket in the web backend (which feeds it), so create it
  // once and hand the same instance to both.
  const pageTools = new PageToolDirectory();
  // The web server is created after the MCP server, so `channel_reload` gets a
  // late-bound thunk: by the time the agent can call the tool, `web` is set.
  let web: WebServer | undefined;
  const mcp = createChannelServer(VERSION, {
    pageTools,
    reload: () => {
      if (!web) {
        throw new Error("web backend not ready yet");
      }
      return web.reload();
    },
  });

  // Push text into the Claude Code session over the one-way channel. Extra meta
  // (the intent-v1 lowering's Option-C attachment paths) rides as additional
  // `<channel>` attributes next to the body tokens that reference them.
  const pushToSession = (
    text: string,
    kind = "prompt",
    extraMeta?: Record<string, string>,
  ): Promise<void> =>
    mcp.notification({
      method: "notifications/claude/channel",
      params: { content: text, meta: { kind, ...extraMeta } },
    });

  // Connect stdio first: the handshake must complete before we open the backend
  // or advertise ourselves, so nothing can push a prompt before the channel is
  // live.
  const transport = new StdioServerTransport();
  await mcp.connect(transport);

  // Lowering traces + the /debug viewer live in the project-local cache
  // (.aiui-cache/ under this server's cwd — gitignored, readable by the
  // Claude Code session running in the same directory).
  const cacheDir = projectCacheDir();
  // The diagnostic log: as an MCP subprocess this process's stderr is
  // effectively invisible, so lifecycle + every error push also land in
  // .aiui-cache/logs/ where a human (or the agent) can read them post-mortem.
  const channelLog = createChannelLog(cacheDir);

  // One debounced directory change drives both notification rungs of the
  // browser-extension proposal (§7): `tools/list_changed` makes the client
  // re-fetch the tool list (measured to work cross-turn AND mid-turn on CLI
  // 2.1.206 — archive/extension-spikes/RESULTS.md M3; the advertised list is
  // still the static meta-tools, so its value is the refresh cycle), and the
  // channel push *names* the tools, because a re-listed tool is not
  // necessarily one a weak model looks up. Subscribed after connect(), so a
  // send can only fail racing shutdown — caught and logged, never fatal.
  const pageToolsNotify = options.pageToolsNotify !== false;
  pageTools.onChange(() => {
    mcp.sendToolListChanged().catch((err) => {
      channelLog.log("tools/list_changed send failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    if (pageToolsNotify) {
      // The directory's signature gate already guarantees the set (or its
      // active-tab flags) really changed since the last signal — no re-hash here.
      pushToSession(formatPageToolsChanged(pageTools.list()), "page-tools").catch((err) => {
        channelLog.log("page-tools push failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  });

  web = await startWebServer({
    onPrompt: (text, meta) => pushToSession(text, "prompt", meta),
    traceDir: cacheDir,
    launchInfo,
    sidecars,
    pageTools,
    frameSink: channelLog.frameSink,
    ...(options.bind === "host" ? { host: "0.0.0.0" } : {}),
    // The *explicit* --tag only (not the UUID minted above): the UUID is an
    // address for the registry, not a human label — an untagged server's
    // trace session labels as "channel·<pid>·<HHMMSS>" (see sessionLabel).
    ...(options.tag !== undefined ? { tag: options.tag } : {}),
  });
  const registration = registerServer(web.port, tag);

  // Dev-only auto-reload on source edits, opt-in via AIUI_CHANNEL_WATCH=1 and
  // only meaningful in a source checkout (a packaged install has nothing on disk
  // to watch). Off by default — the `channel_reload` tool and POST /debug/api/reload
  // are the always-on triggers.
  let stopWatch: (() => void) | undefined;
  if (process.env.AIUI_CHANNEL_WATCH === "1") {
    const srcDir = channelSourceDir();
    if (srcDir) {
      stopWatch = watchChannelSource({
        dir: srcDir,
        onChange: () => {
          web
            ?.reload()
            .then((s) =>
              process.stderr.write(
                `[aiui-channel] reloaded on edit — generation=${s.generation} socketsDropped=${s.socketsDropped}\n`,
              ),
            )
            .catch((err) =>
              process.stderr.write(
                `[aiui-channel] reload failed: ${err instanceof Error ? err.message : String(err)}\n`,
              ),
            );
        },
      });
      process.stderr.write(`[aiui-channel] watching ${srcDir} for edits (AIUI_CHANNEL_WATCH=1)\n`);
    } else {
      process.stderr.write(
        "[aiui-channel] AIUI_CHANNEL_WATCH=1 ignored — not running from source\n",
      );
    }
  }

  // Reliable cleanup. `remove()` is race-safe and idempotent, so calling it from
  // several exit paths is fine. The synchronous `exit` handler is the last-resort
  // backstop — it can't await, so it only unlinks the registry file.
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    channelLog.log("shutdown");
    stopWatch?.();
    registration.remove();
    await web?.close().catch(() => {});
    await mcp.close().catch(() => {});
    await channelLog.close();
  };

  process.on("exit", () => {
    registration.remove();
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      void shutdown().finally(() => process.exit(0));
    });
  }
  // When Claude Code exits, the stdio transport closes; treat that as shutdown.
  mcp.onclose = () => {
    void shutdown().finally(() => process.exit(0));
  };

  // Progress goes to stderr — stdout is the MCP protocol stream.
  process.stderr.write(
    `[aiui-channel] up — tag=${tag} pid=${process.pid} ppid=${process.ppid} port=${web.port} bind=${
      options.bind ?? "loopback"
    } cwd=${process.cwd()} log=${channelLog.path}\n`,
  );
  channelLog.log("up", {
    tag,
    pid: process.pid,
    ppid: process.ppid,
    port: web.port,
    bind: options.bind ?? "loopback",
    cwd: process.cwd(),
  });

  await pushToSession("aiui channel connected", "startup");
}
