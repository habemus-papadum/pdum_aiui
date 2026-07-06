import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, defineConfig, loadEnv, type Plugin, type ViteDevServer } from "vite";
import { parseServeReadyLine } from "./src/serve-ready";

/**
 * The workbench dev server owns two child servers, so `pnpm workbench` is the
 * whole story:
 *
 *  1. **A debug channel server** — `aiui-claude-channel serve` (spawned from
 *     workspace source via tsx). It runs the entire real pipeline — voice
 *     models, corrections, lowering, traces — but has no MCP client attached,
 *     so nothing can ever reach a Claude session. Its cwd is the workbench
 *     package, so workbench traces land in the workbench's own `.aiui-cache/`
 *     (gitignored) and never mix into the project's trace list.
 *  2. **The demo app's Vite server** (packages/aiui-demo), started
 *     programmatically with `VITE_AIUI_PORT` pointed at the debug channel — so
 *     the demo page's own intent overlay (ink, shots, locator, all of it)
 *     streams its turns to the workbench's channel. The workbench embeds it in
 *     an iframe when the demo app is the selected scenery.
 *
 * The page discovers both through `GET /wb/api/servers`. Lowered prompts the
 * channel prints to stdout are forwarded to this terminal with a `[channel]`
 * prefix; `WORKBENCH_RECORD=1` passes `--record` through (frame-log JSONL under
 * `.aiui-cache/recordings/` — future dataset material).
 */

const workbenchDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(workbenchDir, "../../..");
const demoRoot = resolve(repoRoot, "packages/aiui-demo");

const nodeRequire = createRequire(import.meta.url);

/**
 * Resolve the channel CLI to run from workspace source via tsx (the same
 * source-first trick as aiui's resolve-cli.ts, without depending on aiui): find
 * the package root off the module search path, then swap dist/cli.js → src/cli.ts.
 */
function channelCliInvocation(): { command: string; args: string[] } {
  const name = "@habemus-papadum/aiui-claude-channel";
  for (const base of nodeRequire.resolve.paths(name) ?? []) {
    const root = join(base, ...name.split("/"));
    if (existsSync(join(root, "package.json"))) {
      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
        bin?: Record<string, string>;
      };
      const binRel = Object.values(pkg.bin ?? {})[0] ?? "dist/cli.js";
      if (existsSync(join(root, "src"))) {
        const srcRel = binRel.replace(/^\.?\/?dist\//, "src/").replace(/\.js$/, ".ts");
        return { command: process.execPath, args: ["--import", "tsx", resolve(root, srcRel)] };
      }
      return { command: process.execPath, args: [resolve(root, binRel)] };
    }
  }
  throw new Error(`could not locate ${name} in the workspace`);
}

interface ServersState {
  channel?: { port: number; record: boolean };
  demo?: { url: string };
  error?: string;
}

function workbenchServers(): Plugin {
  const state: ServersState = {};
  const record = process.env.WORKBENCH_RECORD === "1";
  let channelChild: ChildProcess | undefined;
  let demoServer: ViteDevServer | undefined;

  const startChannel = (): void => {
    const cli = channelCliInvocation();
    const args = [...cli.args, "serve", "--tag", "workbench", ...(record ? ["--record"] : [])];
    channelChild = spawn(cli.command, args, {
      cwd: workbenchDir, // traces + recordings land in the workbench's own .aiui-cache
      // Watch mode: edit the channel/lowering source and the spawned server
      // hot-rebuilds its format registry — no workbench restart needed.
      env: { ...process.env, AIUI_CHANNEL_WATCH: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    channelChild.on("exit", (code) => {
      if (state.channel === undefined) {
        state.error = `channel server exited with code ${code} before it was ready`;
      }
      state.channel = undefined;
    });
    let buffered = "";
    channelChild.stdout?.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        const ready = parseServeReadyLine(line);
        if (ready) {
          state.channel = { port: ready.port, record };
          console.log(`  [channel] debug server ready on 127.0.0.1:${ready.port}`);
          void startDemo(ready.port);
        } else if (line.trim() !== "") {
          console.log(`  [channel] ${line}`); // lowered prompts + serve chatter
        }
        newline = buffered.indexOf("\n");
      }
    });
    channelChild.stderr?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.trim() !== "") {
          console.error(`  [channel] ${line}`);
        }
      }
    });
  };

  const startDemo = async (channelPort: number): Promise<void> => {
    try {
      // The demo's own vite.config.ts runs its aiuiDevOverlay plugin, which
      // reads VITE_AIUI_PORT from the env — point it at the debug channel
      // before the config loads, and the demo page's intent tool streams here.
      process.env.VITE_AIUI_PORT = String(channelPort);
      demoServer = await createServer({
        root: demoRoot,
        server: { port: 0, host: "127.0.0.1" },
        clearScreen: false,
      });
      await demoServer.listen();
      const address = demoServer.httpServer?.address();
      if (address && typeof address === "object") {
        state.demo = { url: `http://127.0.0.1:${address.port}/` };
        console.log(`  [demo] morphogen dev server ready at ${state.demo.url}`);
      }
    } catch (error) {
      state.error = `demo app failed to start: ${
        error instanceof Error ? error.message : String(error)
      }`;
      console.error(`  [demo] ${state.error}`);
    }
  };

  return {
    name: "workbench-servers",
    configureServer(server) {
      if (process.env.VITEST) {
        return; // vitest loads this config too — tests must not spawn servers
      }
      startChannel();
      server.middlewares.use("/wb/api/servers", (_req, res: ServerResponse) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(state));
      });
      server.httpServer?.on("close", () => {
        channelChild?.kill("SIGTERM");
        void demoServer?.close();
      });
    },
  };
}

export default defineConfig(() => {
  // OPENAI_API_KEY can live in the repo-root .env.dev (gitignored) instead of
  // your shell; the file wins over an inherited env var so a stale export
  // can't shadow it. The spawned channel server inherits it — transcription
  // and correction run channel-side, the key never reaches any page.
  const env = loadEnv("dev", repoRoot, "");
  if (env.OPENAI_API_KEY) {
    process.env.OPENAI_API_KEY = env.OPENAI_API_KEY;
  }
  return { plugins: [workbenchServers()] };
});
