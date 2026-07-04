import type { RunningServer } from "@habemus-papadum/aiui-claude-channel";
import { listMcpServers, selectMcpServer } from "@habemus-papadum/aiui-claude-channel";
import chalk from "chalk";
import { execa } from "execa";
import { infoFlag, splitAiuiArgs } from "../util/aiui-args";
import { type CliInvocation, resolvePackageCli } from "../util/resolve-cli";
import { printError } from "../util/ui";
import { VERSION } from "../util/version";

const VITE_PKG = "vite";

// The environment variable that tells the Vite dev server which channel
// server's web backend to talk to. Read in the dev-server process by the
// aiuiDevOverlay() plugin (@habemus-papadum/aiui-dev-overlay/vite), which
// mounts the intent tool and hands it the port; app source can also read it
// via Vite's `import.meta.env`. It can NOT be read from inside the prebuilt
// overlay bundle — see the overlay package's src/vite.ts for that subtlety.
const VITE_PORT_ENV = "VITE_AIUI_PORT";

/** The channel server `runVite` should point Vite at, or why it couldn't. */
export interface ChannelTarget {
  /** The server resolved without prompting (by tag). */
  server?: RunningServer;
  /** Servers to offer in the interactive selector (no tag given, ≥1 running). */
  select?: RunningServer[];
  /** A human-readable reason a requested server couldn't be resolved. */
  error?: string;
}

/**
 * Decide which running channel server Vite should connect to.
 *
 * Pure so it can be unit-tested without spawning anything:
 *  - With a `targetTag`, return the server whose `tag` matches exactly; if none
 *    matches, return an `error` naming the tag and the tags that *are* running.
 *  - Without a `targetTag`, don't guess: return `{}` when nothing is running, or
 *    `{ select }` so the caller runs the same selector as `quick` (which
 *    auto-picks a lone server and prompts when there are several).
 */
export function resolveChannelTarget(
  servers: RunningServer[],
  targetTag: string | undefined,
): ChannelTarget {
  if (targetTag !== undefined) {
    const server = servers.find((s) => s.tag === targetTag);
    if (!server) {
      const running = servers.length > 0 ? servers.map((s) => s.tag).join(", ") : "(none running)";
      return {
        error: `no running aiui channel with tag "${targetTag}" — running tags: ${running}`,
      };
    }
    return { server };
  }
  return servers.length > 0 ? { select: servers } : {};
}

/**
 * Launch Vite, forwarding any extra args (e.g. `aiui vite dev`,
 * `aiui vite --port 3000`, `aiui vite --version`).
 *
 * Before launching, resolve which running aiui channel server the dev server
 * should talk to — either the one named by `--aiui-mcp <tag>` (or `--aiui-tag`),
 * or, with no tag, the one you pick from the same selector `quick` uses (which
 * auto-selects when only one is running) — and inject its port as
 * {@link VITE_PORT_ENV} so the app can reach it. When a specific tag was asked
 * for but isn't running, we fail loudly instead of connecting to the wrong one.
 *
 * Unlike `claude` — an external tool we look up on the PATH — Vite is a declared
 * dependency of this package, so we resolve it straight out of node_modules and
 * run it via the current Node with an absolute path. Resolving it also doubles
 * as the "is Vite available?" check: if it isn't installed, we fail loudly
 * rather than shelling out to nothing. See {@link resolvePackageCli}.
 */
export async function runVite(rawArgs: string[] = []): Promise<void> {
  const { mcp, tag, passthrough } = splitAiuiArgs(rawArgs);

  // `--help` / `--version` are inert: aiui's own answer, then Vite's — with no
  // channel discovery (which could otherwise block on an interactive picker).
  const info = infoFlag(passthrough);
  if (info) {
    if (info === "help") {
      printViteWrapperHelp();
    } else {
      console.log(`aiui ${VERSION}`);
    }
    await forwardToVite(passthrough);
    return;
  }

  // `--aiui-mcp` is the purpose-built selector; `--aiui-tag` is accepted too.
  const targetTag = mcp ?? tag;

  const target = resolveChannelTarget(listMcpServers(), targetTag);
  if (target.error) {
    printError("Could not resolve an aiui channel", target.error);
    process.exitCode = 1;
    return;
  }

  // A tag resolves directly; otherwise the selector (shared with `quick`) picks
  // — returning the lone server without prompting, or asking when there's more
  // than one.
  const server = target.select ? await selectMcpServer(target.select) : target.server;

  let port: string | undefined;
  if (server) {
    port = String(server.port);
    console.error(
      chalk.dim(
        `aiui: connecting vite to channel "${server.tag}" (${server.cwd}) on port ${port} via ${VITE_PORT_ENV}`,
      ),
    );
  } else {
    console.error(chalk.dim(`aiui: no running channel found — ${VITE_PORT_ENV} left unset`));
  }

  const vite = resolveVite();
  if (!vite) {
    return;
  }

  // stdio inherit so the dev server owns the terminal and Ctrl-C reaches it.
  // reject:false so a non-zero/interrupted Vite exit is propagated as our exit
  // code instead of throwing an error the user didn't cause. execa merges `env`
  // over process.env, so we only add VITE_AIUI_PORT when we actually resolved one.
  const result = await execa(vite.command, [...vite.args, ...passthrough], {
    stdio: "inherit",
    reject: false,
    ...(port ? { env: { [VITE_PORT_ENV]: port } } : {}),
  });
  if (result.exitCode) {
    process.exitCode = result.exitCode;
  }
}

/** Resolve the Vite CLI; print the friendly install pointer when missing. */
function resolveVite(): CliInvocation | undefined {
  try {
    return resolvePackageCli(VITE_PKG);
  } catch {
    printError(
      "Vite is not available",
      "`vite` should be installed as a dependency of aiui — try reinstalling.",
    );
    process.exitCode = 1;
    return undefined;
  }
}

/** Run Vite with the args verbatim (the --help/--version forward). */
async function forwardToVite(args: string[]): Promise<void> {
  const vite = resolveVite();
  if (!vite) {
    return;
  }
  const result = await execa(vite.command, [...vite.args, ...args], {
    stdio: "inherit",
    reject: false,
  });
  if (result.exitCode) {
    process.exitCode = result.exitCode;
  }
}

/** The aiui half of `aiui vite --help` (vite's own --help follows it). */
function printViteWrapperHelp(): void {
  console.log(`aiui vite — launch Vite connected to the running aiui channel

aiui's own flags (everything else forwards to vite verbatim):
  --aiui-mcp <tag>   connect to the channel server with this tag
  --aiui-tag <tag>   accepted alias for --aiui-mcp

The chosen channel's port is exported as VITE_AIUI_PORT; the aiuiDevOverlay()
Vite plugin picks it up there and wires the intent tool to it. What follows is
vite's own --help:
`);
}
