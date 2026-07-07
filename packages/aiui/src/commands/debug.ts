/**
 * `aiui debug` — the standalone trace-debugger frontend.
 *
 * The channel serves **no HTML** (it is a JSON/data server); every viewer is a
 * frontend process. This command is that frontend when there's no app dev
 * server to piggyback on: it picks a running channel (the same registry +
 * selector `aiui vite` uses — a lone channel is taken directly, several
 * prompt), then runs a small Vite dev server whose only job is the
 * `aiuiDevOverlay()` plugin's `/__aiui/debug` page — the shared debug-ui
 * viewer (trace list + live-followed TraceView). The page's header offers a
 * **channel switcher** fed by the channel's `/debug/api/channels` route, so
 * one command inspects every channel on the machine, hopping between them
 * mid-session.
 *
 * Vite (a real dependency of this package) is used as the module server so the
 * viewer is served exactly the way the in-app `/__aiui/debug` page is — one
 * implementation, no prebuilt bundle to keep in sync. The server root is this
 * package's own directory: that is where `@habemus-papadum/aiui-dev-overlay`
 * (the virtual mount module's import) resolves from, in both the workspace
 * (source-first) and installed (dist) shapes.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listMcpServers, selectMcpServer } from "@habemus-papadum/aiui-claude-channel";
import { aiuiDevOverlay } from "@habemus-papadum/aiui-dev-overlay/vite";
import chalk from "chalk";
import { createServer, type Plugin } from "vite";
import { printError } from "../util/ui";
import { resolveChannelTarget } from "./vite";

/** The route the overlay plugin serves the viewer at (its contract). */
const DEBUG_ROUTE = "/__aiui/debug";

/** Default UI port; Vite walks up from here when it's taken. */
const DEFAULT_UI_PORT = 4747;

export interface DebugOptions {
  /** Target a channel by its registry tag instead of the interactive selector. */
  mcp?: string;
  /** UI port for the viewer's dev server (default {@link DEFAULT_UI_PORT}). */
  port?: string;
  /** Open the browser at the viewer (default true; `--no-open` skips). */
  open?: boolean;
}

/**
 * This package's root — the Vite server root, found by walking up from this
 * module to the `@habemus-papadum/aiui` package.json (two levels in the
 * source tree, but the walk keeps it honest against dist layouts too).
 */
export function packageRoot(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        const name = (JSON.parse(readFileSync(candidate, "utf8")) as { name?: string }).name;
        if (name === "@habemus-papadum/aiui") {
          return dir;
        }
      } catch {
        // unreadable package.json — keep walking
      }
    }
    dir = dirname(dir);
  }
  return undefined;
}

export async function runDebug(opts: DebugOptions = {}): Promise<void> {
  const target = resolveChannelTarget(listMcpServers(), opts.mcp);
  if (target.error) {
    printError("Could not resolve an aiui channel", target.error);
    process.exitCode = 1;
    return;
  }
  const server = target.select ? await selectMcpServer(target.select) : target.server;
  if (!server) {
    console.log("No running aiui channel to debug — start one with `aiui claude`.");
    process.exitCode = 1;
    return;
  }

  const root = packageRoot();
  if (!root) {
    printError("Could not locate the aiui package root to serve the viewer from");
    process.exitCode = 1;
    return;
  }

  // "/" is not a page here — send it to the viewer.
  const home: Plugin = {
    name: "aiui:debug-home",
    configureServer(viteServer) {
      viteServer.middlewares.use((req, res, next) => {
        if ((req.url ?? "/").split("?")[0] === "/") {
          res.statusCode = 302;
          res.setHeader("location", DEBUG_ROUTE);
          res.end();
          return;
        }
        next();
      });
    },
  };

  const uiPort = Number(opts.port);
  const ui = await createServer({
    root,
    configFile: false,
    // `mount: false`: this server hosts the viewer, not an app — nothing to
    // arm, so the intent tool stays out of it. The plugin still serves the
    // DEBUG_ROUTE page and seeds the picked channel's port into it.
    plugins: [home, aiuiDevOverlay({ port: server.port, mount: false }) as Plugin],
    server: {
      port: Number.isInteger(uiPort) && uiPort > 0 ? uiPort : DEFAULT_UI_PORT,
      open: opts.open === false ? false : DEBUG_ROUTE,
    },
    logLevel: "warn",
  });
  await ui.listen();

  const local = ui.resolvedUrls?.local[0] ?? `http://localhost:${DEFAULT_UI_PORT}/`;
  const url = `${local.replace(/\/$/, "")}${DEBUG_ROUTE}`;
  console.log(`${chalk.cyan("aiui debug")} — the lowering-trace viewer`);
  console.log(`  viewing  ${chalk.bold(url)}`);
  console.log(
    chalk.dim(`  channel  "${server.tag}" (${server.cwd}) on port ${server.port}`) +
      chalk.dim(" — switch channels from the page's header. Ctrl-C to stop."),
  );
}
