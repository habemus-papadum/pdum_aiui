import { Command } from "commander";
import { type BrowserOptions, runBrowser, runOpen } from "./commands/browser";
import { runChrome } from "./commands/chrome";
import { runClaude } from "./commands/claude";
import {
  runConfigGet,
  runConfigSet,
  runConfigShow,
  runConfigUnset,
  type ShowOptions,
  type WriteOptions,
} from "./commands/config";
import { runConfigTui } from "./commands/config-tui";
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

  // The two-level config.json, self-documenting: every subcommand renders from
  // the same schema table validation uses (util/config-schema.ts). Bare
  // `aiui config` opens the interactive browser.
  const config = program
    .command("config")
    .description("inspect and edit aiui's config.json — tui | show | get | set | unset")
    .action(() => runConfigTui());
  config
    .command("tui")
    .description("browse every setting interactively: docs, defaults, current values, editing")
    .action(() => runConfigTui());
  config
    .command("show")
    .description("every key with its effective value and which file set it")
    .option("--json", "machine-readable: file paths, per-level values, effective merge")
    .action((opts: ShowOptions) => runConfigShow(opts));
  config
    .command("get")
    .description("print a key's effective value (provenance goes to stderr)")
    .argument("<key>", 'dotted key, e.g. "chrome.mode"')
    .action((key: string) => runConfigGet(key));
  config
    .command("set")
    .description("set a key in the user config (or the project's with --project)")
    .argument("<key>", 'dotted key, e.g. "chrome.mode"')
    .argument("<value>", "the new value, validated against the schema")
    .option("--project", "write .aiui-cache/config.json here instead of the user config")
    .action((key: string, value: string, opts: WriteOptions) => runConfigSet(key, value, opts));
  config
    .command("unset")
    .description("remove a key from the user config (or the project's with --project)")
    .argument("<key>", 'dotted key, e.g. "claude.skipPermissions"')
    .option("--project", "remove from .aiui-cache/config.json here instead of the user config")
    .action((key: string, opts: WriteOptions) => runConfigUnset(key, opts));

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
