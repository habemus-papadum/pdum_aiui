import { randomUUID } from "node:crypto";
import { openInSessionBrowser } from "@habemus-papadum/aiui-util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createChannelLog } from "../channel-log";
import { dashboardTabTarget } from "../dashboard-tab";
import { STALE_NOTICE } from "../hot";
import { type LaunchInfo, parseLaunchInfo } from "../launch-info";
import { formatPageToolsChanged, PageToolDirectory } from "../page-tools";
import { registerServer } from "../registry";
import { createChannelServer } from "../server";
import { projectCacheDir } from "../trace";
import { resolveAndStashVendorKeys } from "../vendor-key-stash";
import { startWebServer, type WebServer } from "../web";
import {
  type CommonChannelOptions,
  commonWebOptions,
  createShutdown,
  installExitBackstop,
  resolveSidecars,
  startStalenessWatch,
} from "./lifecycle";

export interface McpOptions extends CommonChannelOptions {
  /**
   * JSON launch summary from the launcher (`aiui claude`) — how the session's
   * Chrome DevTools MCP was wired, etc. Parsed tolerantly (it's diagnostics,
   * not behavior) and surfaced at `GET /debug/api/info`. See launch-info.ts.
   */
  launchInfo?: string;
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
  // The sidecars to host. The channel composes its own standard set by ordinary
  // import (standard-sidecars.ts) — rooted at this process's cwd, which the
  // launcher sets to the project root. Tests inject their own to stay hermetic.
  // Each mount is isolated by `startWebServer`: one that throws is logged and
  // skipped, never fatal.
  const sidecars = resolveSidecars(options);
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

  // Lowering traces + the /debug viewer live in the project's USER-LEVEL
  // cache (~/.cache/aiui/projects/<slug>-<hash>/, keyed by this server's cwd —
  // trace.ts; blob paths stay absolute so the Claude Code session can read
  // them from anywhere, and the project tree stays pristine).
  const cacheDir = projectCacheDir();
  // The diagnostic log: as an MCP subprocess this process's stderr is
  // effectively invisible, so lifecycle + every error push also land in that
  // cache's logs/ where a human (or the agent) can read them post-mortem.
  const channelLog = createChannelLog(cacheDir);

  // Resolve the three vendor keys ONCE, before any thread can need them
  // (vendor-key-stash.ts): source mode honors the environment, an installed
  // channel reads the OS vault only — so installed users' keys never ride
  // through claude's env. Never throws, never hangs (timeouts degrade to
  // keyless); the log line records each key's SOURCE, never a value.
  await resolveAndStashVendorKeys((message) => channelLog.log(message));

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

  // A web backend that fails to start is FATAL, and loudly so. Without the
  // try/catch, the rejection bubbles to cli.ts, which logs to stderr — invisible
  // for an MCP subprocess — and the connected stdio transport then keeps a
  // zombie alive: MCP reachable, no web port, no registry entry, nothing in the
  // channel log (exactly how the `isSourceRun` path bug hid for a day). Log it
  // where post-mortems look, tell the session, and exit so Claude Code surfaces
  // a dead MCP server instead of a silently useless one.
  try {
    web = await startWebServer({
      onPrompt: (text, meta) => pushToSession(text, "prompt", meta),
      traceDir: cacheDir,
      launchInfo,
      sidecars,
      pageTools,
      frameSink: channelLog.frameSink,
      ...commonWebOptions(options),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    channelLog.log("web backend failed to start — exiting", { error: message });
    process.stderr.write(`[aiui-channel] web backend failed to start: ${message}\n`);
    await pushToSession(
      `⚠️ aiui channel: the web backend failed to start (${message}). ` +
        "The channel is exiting — no intent client, dashboard, or sidecar will work " +
        `this session. See the channel log under ${cacheDir}/logs/.`,
      "channel-error",
    ).catch(() => {});
    await channelLog.close().catch(() => {});
    await mcp.close().catch(() => {});
    process.exit(1);
  }

  // Now that the web server has a port, open THIS channel's dashboard (the
  // console served at /) as a tab in the session browser the launcher opened —
  // the "browser open mode". The launcher already launched the browser and
  // pointed the Chrome DevTools MCP at it; only WE know the port to reach the
  // dashboard, so the tab is opened here. Gated on a LOCAL loopback session
  // browser (a userDataDir we manage, not a remote `--aiui-browser-url`).
  // Best-effort: a failure just means no dashboard tab, never a dead channel.
  const dashboardTab = dashboardTabTarget(launchInfo?.chromeDevtools, web.port);
  if (dashboardTab) {
    try {
      await openInSessionBrowser(dashboardTab.browserUrl, dashboardTab.dashboardUrl);
      channelLog.log(`opened the dashboard tab (${dashboardTab.dashboardUrl})`);
    } catch (err) {
      channelLog.log("dashboard tab open failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // A real session channel: kind "channel" (the ppid → `claude agents` join
  // names it live); the DevTools endpoint rides along so cold discoverers can
  // find the session browser without the launcher (schema v2, §3).
  const registration = registerServer({
    port: web.port,
    tag,
    kind: "channel",
    browserUrl: launchInfo?.chromeDevtools?.browserUrl,
  });

  // Dev-only STALENESS watch, opt-in via AIUI_CHANNEL_WATCH=1 and only
  // meaningful in a source checkout (a packaged install has nothing on disk to
  // watch). The channel does NOT hot-reload — a shallow format-registry swap
  // used to run here and gave a false sense of HMR; it was removed. Instead,
  // when the channel's own backend source changes, we tell the AGENT its running
  // channel is now stale, so nobody trusts behavior that no longer matches disk.
  // (Manual reload — the `channel_reload` tool and POST /debug/api/reload —
  // stays for the deliberate case.)
  let notified = false;
  const stopWatch = startStalenessWatch({
    logPrefix: "[aiui-channel]",
    onStale: () => {
      const notice = notified
        ? "aiui channel source changed again — still running the OLD build; restart to apply."
        : STALE_NOTICE;
      notified = true;
      channelLog.log("stale");
      pushToSession(notice, "channel-stale").catch((err) => {
        channelLog.log("stale push failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
      process.stderr.write("[aiui-channel] source changed — told the session it is stale\n");
    },
  });

  // Reliable cleanup. `remove()` is race-safe and idempotent, so calling it from
  // several exit paths is fine. The synchronous `exit` handler is the last-resort
  // backstop — it can't await, so it only unlinks the registry file. Both closes
  // are error-swallowed (this twin tolerates a wedged web or MCP close on the way
  // out); channelLog.close() stays last (owned by createShutdown).
  const shutdown = createShutdown({
    channelLog,
    registration,
    closers: [stopWatch, () => web?.close().catch(() => {}), () => mcp.close().catch(() => {})],
  });

  installExitBackstop(registration);
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
