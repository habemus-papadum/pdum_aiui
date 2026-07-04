import { Command } from "commander";
import { type BrowserOptions, runBrowser, runOpen } from "./commands/browser";
import { runChrome } from "./commands/chrome";
import { runClaude } from "./commands/claude";
import { type DemoOptions, runDemo } from "./commands/demo";
import { runMcp } from "./commands/mcp";
import { runVite } from "./commands/vite";

import { VERSION } from "./util/version";

/**
 * Build the `aiui` command tree.
 *
 * Kept separate from the executable entrypoint (cli.ts) so tests can construct
 * and inspect the program without actually running it.
 */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name("aiui")
    .description("ai ui frontends — thin launchers for Claude, Vite, and the channel CLI")
    .version(VERSION)
    // Only treat options as aiui's own when they come *before* the subcommand.
    // Without this, commander parses interspersed options and would swallow e.g.
    // `aiui vite --version` as aiui's own --version instead of forwarding it.
    .enablePositionalOptions();

  // Both subcommands are thin wrappers: everything after the subcommand name is
  // forwarded verbatim to the underlying tool. allowUnknownOption + helpOption(false)
  // stop commander from intercepting flags like `--resume` or `--help`, and the
  // variadic `[args...]` collects them for the action to pass through.
  program
    .command("claude")
    .description("launch Claude (extra args are forwarded, e.g. `aiui claude --resume`)")
    .allowUnknownOption()
    .allowExcessArguments()
    .helpOption(false)
    .argument("[args...]", "arguments forwarded to claude")
    .action((args: string[]) => runClaude(args));

  program
    .command("vite")
    .description("launch Vite (extra args are forwarded, e.g. `aiui vite dev`)")
    .allowUnknownOption()
    .allowExcessArguments()
    .helpOption(false)
    .argument("[args...]", "arguments forwarded to vite")
    .action((args: string[]) => runVite(args));

  // Unlike its siblings, `aiui chrome` is a real subcommand (not a forwarding
  // wrapper): it manages the agent's browser — the Chrome for Testing install,
  // launch status, and the devtools extension path.
  program
    .command("chrome")
    .description("manage the agent's browser: install | update | status | extension")
    .argument("<action>", "install | update | status | extension")
    .action((action: string) => runChrome([action]));

  // The shared session browser (human + agent in one window). `browser` starts
  // or finds it — locally before/without a session, or on your local machine
  // for remote development (tunnel its debug port to the remote box).
  program
    .command("browser")
    .description(
      "start (or find) the shared session browser; --tunnel does the whole remote-dev local half",
    )
    .option(
      "--profile <name>",
      "named profile (project .aiui-cache/chrome/, or the user cache with --tunnel)",
    )
    .option("--data-dir <path>", "explicit Chrome user data dir")
    .option("--port <port>", "fixed local DevTools debug port (default: OS-assigned)")
    .option("--headless", "launch with no UI")
    .option("--open <url>", "also open this URL in it")
    .option(
      "--tunnel <[user@]host>",
      "reverse-tunnel the debug port to this host (Ctrl-C closes it)",
    )
    .option("--remote-port <port>", "fixed port on the tunnel's remote side (default: 9222)")
    .action((opts: BrowserOptions) => runBrowser(opts));

  // A disposable, npx-able playground: scaffolds a sample app into the user's
  // own directory (its own git repo — agent edits stay in the sandbox) and is
  // safe to re-run: an existing demo continues instead of being re-scaffolded.
  program
    .command("demo")
    .description("scaffold a runnable demo playground (safe to re-run; default dir: aiui-demo)")
    .argument("[dir]", "target directory (default: aiui-demo)")
    .option("--skip-install", "scaffold only — don't run npm install")
    .action((dir: string | undefined, opts: DemoOptions) => runDemo(dir, opts));

  program
    .command("open")
    .description("open a URL in the session browser, e.g. `aiui open http://localhost:5173`")
    .argument("<url>", "the URL to open")
    .option("--profile <name>", "named profile under .aiui-cache/chrome/")
    .option("--data-dir <path>", "explicit Chrome user data dir")
    .action((url: string, opts: Pick<BrowserOptions, "profile" | "dataDir">) => runOpen(url, opts));

  // `aiui mcp <args...>` forwards to the aiui-claude-channel CLI, so the
  // user-facing channel commands live under `aiui` (e.g. `aiui mcp quick`)
  // without duplicating them or moving them off the package that owns the
  // in-process MCP server.
  program
    .command("mcp")
    .description("run a channel command (forwards to aiui-claude-channel), e.g. `aiui mcp quick`")
    .allowUnknownOption()
    .allowExcessArguments()
    .helpOption(false)
    .argument("[args...]", "arguments forwarded to the aiui-claude-channel CLI")
    .action((args: string[]) => runMcp(args));

  return program;
}
