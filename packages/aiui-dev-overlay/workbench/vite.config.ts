import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, watch as fsWatch, readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Plugin } from "vite";
import solid from "vite-plugin-solid";
import {
  isPortTakenError,
  portTakenHint,
  resolveWorkbenchPorts,
  type WorkbenchPorts,
} from "./src/ports";
import { parseServeReadyLine } from "./src/serve-ready";

/**
 * The workbench dev server owns one child server, so `pnpm workbench` is the
 * whole story: **a debug channel server** — `aiui-claude-channel serve`
 * (spawned from workspace source via tsx). It runs the entire real pipeline —
 * voice models, corrections, lowering, traces — but has no MCP client
 * attached, so nothing can ever reach a Claude session. Its cwd is the
 * workbench package, so workbench traces land in the workbench's own
 * `.aiui-cache/` (gitignored) and never mix into the project's trace list. It
 * hosts the same session sidecars a real `aiui claude` launch would, and
 * binds per the user's own `channel.bind` config — both the CLI's own policy,
 * reused via a tsx runner (see resolveChannelSettings) — so sidecar-backed
 * features (and LAN reachability, e.g. an iPad on the paint page) behave
 * exactly as they would in a real session.
 *
 * Both servers bind **fixed, known ports** (see src/ports.ts for the
 * rationale and the env overrides):
 *
 *   49222  workbench UI        WORKBENCH_PORT
 *   49223  debug channel       WORKBENCH_CHANNEL_PORT
 *
 * strictPort everywhere — a taken port fails loudly with an "is another
 * workbench running?" hint instead of drifting somewhere random. The fixed
 * values are requests, though, not assumptions: the channel's actual port is
 * still read off its `AIUI_CHANNEL_SERVE` ready line (src/serve-ready.ts), so
 * `GET /wb/api/servers` — how the page discovers the child — reports ground
 * truth, never the config.
 *
 * Lowered prompts the channel prints to stdout are forwarded to this terminal
 * with a `[channel]` prefix; `WORKBENCH_RECORD=1` passes `--record` through
 * (frame-log JSONL under `.aiui-cache/recordings/` — future dataset material).
 *
 * Channel-side edits **restart the channel child** (watched: the channel's
 * `src/` and the overlay's `src/intent-pipeline/`) instead of relying on the
 * channel's in-process hot reload, whose documented one-level re-import
 * boundary silently misses deep edits (reloadable.ts). Full restart, full
 * freshness; the fixed port keeps every client's next connection valid.
 *
 * Once the workbench UI is listening, a browser sidecar opens it in the
 * session browser — the same autolaunch behavior as `aiui vite`, built on the
 * shared pieces in aiui-util (see src/open-browser.ts). Headless environments
 * get a where-to-point-a-browser hint instead; `WORKBENCH_BROWSER=1` / `=0`
 * force / suppress it.
 */

const workbenchDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(workbenchDir, "../../..");

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

/**
 * The browser sidecar, `aiui vite`-style: fire-and-forget once the UI is up.
 * Whatever the browser does — including there being no Chrome to launch —
 * the workbench keeps running; failures degrade to printing the URL.
 *
 * The sidecar runs from source via tsx as a child process, like the channel
 * server, and NOT as an import from this config: Vite externalizes a config
 * file's bare imports, so workspace TS reached from here would be loaded by
 * plain Node, which can't resolve the linked sources' extensionless relative
 * imports. See src/open-browser-cli.ts (the runner) and src/open-browser.ts
 * (the decision + session-browser open, shared plumbing from aiui-util).
 */
function autoOpenBrowser(url: string): void {
  const script = resolve(workbenchDir, "src/open-browser-cli.ts");
  const child = spawn(process.execPath, ["--import", "tsx", script, url, repoRoot], {
    cwd: workbenchDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const forward = (chunk: Buffer): void => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (line.trim() !== "") {
        console.log(`  [workbench] ${line}`);
      }
    }
  };
  child.stdout?.on("data", forward);
  child.stderr?.on("data", forward);
  child.on("error", (error) => {
    console.error(`  [workbench] browser sidecar failed to start: ${error.message}`);
  });
}

/** How the debug channel should launch, per `aiui claude`'s own policy. */
interface ChannelSettings {
  /** The `--sidecars` JSON for `serve`, or undefined (none detected / resolution failed). */
  sidecarsJson?: string;
  /** The user's `channel.bind` from the aiui config — obeyed, never forced. */
  bind: "loopback" | "host";
}

/**
 * Resolve the debug channel's launch settings — which session sidecars to
 * host (`resolveSidecars`) and where to bind (`channel.bind` from the layered
 * aiui config) — by reusing `aiui claude`'s own policy through the aiui
 * package instead of re-deriving it, so the workbench's channel behaves
 * exactly as a real session's would (a LAN iPad reaches the paint page iff
 * the user's config says `bind: host`).
 *
 * Runs as a tsx child for the same reason as the browser sidecar (see
 * {@link autoOpenBrowser}): the config can't import workspace TS directly.
 * Any failure degrades to `{ bind: "loopback" }` with no sidecars — the
 * workbench runs on, on the safe default.
 */
function resolveChannelSettings(): Promise<ChannelSettings> {
  return new Promise((resolvePromise) => {
    const script = resolve(workbenchDir, "src/resolve-channel-settings-cli.ts");
    const child = spawn(process.execPath, ["--import", "tsx", script, repoRoot], {
      cwd: workbenchDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.trim() !== "") {
          console.error(`  [channel] ${line}`);
        }
      }
    });
    child.on("error", (error) => {
      console.error(`  [channel] settings resolution failed to start: ${error.message}`);
      resolvePromise({ bind: "loopback" });
    });
    child.on("exit", (code) => {
      const json = out.trim();
      if (code !== 0 || json === "") {
        if (code !== 0) {
          console.error(
            `  [channel] settings resolution exited with code ${code} — loopback, no sidecars`,
          );
        }
        resolvePromise({ bind: "loopback" });
        return;
      }
      try {
        const parsed = JSON.parse(json) as { sidecars?: unknown[]; bind?: unknown };
        resolvePromise({
          ...(Array.isArray(parsed.sidecars) && parsed.sidecars.length > 0
            ? { sidecarsJson: JSON.stringify(parsed.sidecars) }
            : {}),
          bind: parsed.bind === "host" ? "host" : "loopback",
        });
      } catch {
        console.error("  [channel] settings resolution printed malformed JSON — defaults");
        resolvePromise({ bind: "loopback" });
      }
    });
  });
}

interface ServersState {
  channel?: { port: number; record: boolean };
  error?: string;
}

function workbenchServers(ports: WorkbenchPorts): Plugin {
  const state: ServersState = {};
  const record = process.env.WORKBENCH_RECORD === "1";
  let channelChild: ChildProcess | undefined;
  // Set while a source-edit restart is in flight: tells the exit handler this
  // death is deliberate (respawn, don't report). shuttingDown wins over both.
  let restartPending = false;
  let shuttingDown = false;
  // The channel's launch settings (sidecars + bind), resolved once
  // (asynchronously, see configureServer) before the first start; every
  // (re)start reuses them. `undefined` doubles as "not resolved yet" —
  // startChannel must not run before it lands, or a restart would silently
  // drop the sidecars and the configured bind.
  let channelSettings: ChannelSettings | undefined;

  const startChannel = (): void => {
    const cli = channelCliInvocation();
    const args = [
      ...cli.args,
      "serve",
      "--tag",
      "workbench",
      // How selectors (quick, aiui vite, the VS Code extension) title this
      // channel — its registry entry carries debug:true, so they all mark it.
      "--name",
      "aiui workbench",
      // The channel's fixed address. serve fails hard when the port is taken
      // (never drifts), and its actual port still arrives on the ready line —
      // which stays the single source of truth below.
      "--port",
      String(ports.channel),
      ...(record ? ["--record"] : []),
      // The session sidecars a real launch would host, and the user's own
      // channel.bind — both resolved via aiui claude's policy before the first
      // start (see resolveChannelSettings). bind:"host" is what lets a LAN
      // iPad reach the paint page; the workbench obeys it, never forces it.
      ...(channelSettings?.sidecarsJson !== undefined
        ? ["--sidecars", channelSettings.sidecarsJson]
        : []),
      ...(channelSettings?.bind === "host" ? ["--bind", "host"] : []),
    ];
    channelChild = spawn(cli.command, args, {
      cwd: workbenchDir, // traces + recordings land in the workbench's own .aiui-cache
      // Deliberately NOT AIUI_CHANNEL_WATCH=1: the in-process reload only
      // re-imports one module level (the documented boundary in the channel's
      // reloadable.ts — an edit to transcribe.ts/realtime.ts is invisible to
      // it). The workbench instead fully restarts this child on source edits
      // (the watcher in configureServer), which reloads *everything*.
      //
      // AIUI_PROMPT_CWD: the child's cwd is the workbench package (for the
      // cache), but prompt paths — screenshots and source locations — should
      // relativize against the REPO root, the directory an agent working on
      // this codebase actually sits in.
      env: { ...process.env, AIUI_PROMPT_CWD: repoRoot },
      stdio: ["ignore", "pipe", "pipe"],
    });
    // The child explains a port collision on its own stderr ("port 49223 is
    // already in use — …"), but it can't know the workbench's env override.
    // Remember seeing that line so the exit handler can add the missing half.
    let sawPortTaken = false;
    channelChild.on("exit", (code) => {
      const wasReady = state.channel !== undefined;
      state.channel = undefined;
      if (restartPending && !shuttingDown) {
        restartPending = false;
        startChannel(); // a source-edit restart: this death was ours
        return;
      }
      if (!wasReady) {
        state.error = `channel server exited with code ${code} before it was ready`;
        if (sawPortTaken) {
          console.error(`  [channel] ${portTakenHint("channel", ports)}`);
        }
      }
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
        } else if (line.trim() !== "") {
          console.log(`  [channel] ${line}`); // lowered prompts + serve chatter
        }
        newline = buffered.indexOf("\n");
      }
    });
    channelChild.stderr?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.trim() !== "") {
          sawPortTaken ||= /already in use/i.test(line);
          console.error(`  [channel] ${line}`);
        }
      }
    });
  };

  return {
    name: "workbench-servers",
    configureServer(server) {
      if (process.env.VITEST) {
        return; // vitest loads this config too — tests must not spawn servers
      }
      // The workbench's own server hasn't listened yet (configureServer runs
      // first), so hook its lifecycle: one line making the pinned URL obvious
      // next to the [channel]/[demo] ready lines, and — since strictPort turns
      // a taken port into a fatal EADDRINUSE — a hint that beats the bare
      // stack to the terminal.
      server.httpServer?.once("listening", () => {
        const address = server.httpServer?.address();
        const port = address && typeof address === "object" ? address.port : ports.workbench;
        const url = `http://127.0.0.1:${port}/`;
        console.log(`  [workbench] ui ready at ${url}`);
        autoOpenBrowser(url);
      });
      server.httpServer?.on("error", (error) => {
        if (isPortTakenError(error)) {
          console.error(`  [workbench] ${portTakenHint("workbench", ports)}`);
        }
      });
      // The channel start waits for settings resolution (~one tsx boot): the
      // sidecar set and the bind are part of the serve args, so starting early
      // would bring the channel up sidecar-less on the wrong interface — and a
      // later source-edit restart would keep it that way.
      void resolveChannelSettings().then((settings) => {
        channelSettings = settings;
        if (!shuttingDown && channelChild === undefined) {
          startChannel();
        }
      });
      // Full-restart watch over the channel-side source. The channel's own
      // hot reload deliberately re-imports only one module level (see the
      // boundary documented in aiui-claude-channel's reloadable.ts) — deep
      // edits (transcribe.ts, realtime.ts, prompt-context.ts, the shared
      // intent-pipeline) never reach a warm process, which cost a real
      // debugging round ("my server-side fix didn't take effect"). In the lab,
      // correctness beats warmth: restart the child on any source edit. ~1s,
      // and the fixed port means the page's next turn reconnects untouched.
      const watchedDirs = [
        resolve(repoRoot, "packages/aiui-claude-channel/src"),
        resolve(repoRoot, "packages/aiui-dev-overlay/src/intent-pipeline"),
      ];
      let restartTimer: ReturnType<typeof setTimeout> | undefined;
      const watchers = watchedDirs.map((dir) =>
        fsWatch(dir, { recursive: true }, (_event, filename) => {
          if (!filename || !/\.tsx?$/.test(filename) || /\.test\.tsx?$/.test(filename)) {
            return;
          }
          if (restartTimer) {
            clearTimeout(restartTimer);
          }
          restartTimer = setTimeout(() => {
            restartTimer = undefined;
            if (shuttingDown) {
              return;
            }
            console.log(`  [channel] ${filename} changed — restarting the channel server`);
            if (channelChild && channelChild.exitCode === null) {
              restartPending = true;
              channelChild.kill("SIGTERM");
            } else if (channelSettings !== undefined) {
              // Also recovers a crashed channel on the next edit. Before the
              // settings resolve there is nothing to recover — the pending
              // resolution above does the first start.
              startChannel();
            }
          }, 400);
        }),
      );
      server.middlewares.use("/wb/api/servers", (_req, res: ServerResponse) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(state));
      });
      server.httpServer?.on("close", () => {
        shuttingDown = true;
        if (restartTimer) {
          clearTimeout(restartTimer);
        }
        for (const watcher of watchers) {
          watcher.close();
        }
        channelChild?.kill("SIGTERM");
      });
    },
  };
}

export default defineConfig(() => {
  // OPENAI_API_KEY can live in the repo-root .env.dev (gitignored) instead of
  // your shell; the file wins over an inherited env var so a stale export
  // can't shadow it. The spawned channel server inherits it — transcription
  // and correction run channel-side, the key never reaches any page.
  // GEMINI_API_KEY rides the same slot, for the realtime submode's Gemini Live
  // session (channel-side too — see the realtime handoff §6).
  const env = loadEnv("dev", repoRoot, "");
  if (env.OPENAI_API_KEY) {
    process.env.OPENAI_API_KEY = env.OPENAI_API_KEY;
  }
  if (env.GEMINI_API_KEY) {
    process.env.GEMINI_API_KEY = env.GEMINI_API_KEY;
  }
  // The fixed port layout (49222/49223 unless WORKBENCH_*PORT overrides
  // — see src/ports.ts). Resolved here, once, so a bad override fails the
  // whole launch immediately with the offending var named.
  const ports = resolveWorkbenchPorts();
  return {
    // The overlay package's absolute path, for main.ts to seed
    // window.__AIUI__.sourceRoot (scenery's hand-written data-source-loc
    // stamps are overlay-package-relative) — what makes vscode-mode jumps
    // resolve to real vscode://file/ URLs without the aiuiDevOverlay plugin.
    define: { __WB_SOURCE_ROOT__: JSON.stringify(resolve(workbenchDir, "..")) },
    // solid(): the workbench page itself is plain TS, but it imports the
    // overlay from workspace SOURCE (the editable-install convention), and the
    // overlay's widget is Solid-rendered .tsx — without the Solid transform,
    // esbuild compiles that JSX to React.createElement and the overlay dies at
    // mount with "React is not defined".
    plugins: [solid(), workbenchServers(ports)],
    // strictPort: the workbench promises its user a known address; a taken
    // port must fail loudly (with the [workbench] hint from the plugin), not
    // slide to 49223 and displace its own channel server. The explicit
    // 127.0.0.1 matches the channel (Vite's default "localhost" can
    // resolve to ::1 only, and then http://127.0.0.1:49222/ — the address we
    // print and document — would refuse connections).
    server: { host: "127.0.0.1", port: ports.workbench, strictPort: true },
  };
});
