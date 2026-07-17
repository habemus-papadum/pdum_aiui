import { Command } from "commander";
import { type BrowserOptions, runBrowser, runOpen } from "./commands/browser";
import { runChrome } from "./commands/chrome";
import { runClaude } from "./commands/claude";
import { type CleanOptions, runClean } from "./commands/clean";
import {
  runConfigGet,
  runConfigSet,
  runConfigShow,
  runConfigUnset,
  type ShowOptions,
  type WriteOptions,
} from "./commands/config";
import { runConfigTui } from "./commands/config-tui";
import { type DebugOptions, runDebug } from "./commands/debug";
import { runEnv } from "./commands/env";
import { type ExtensionOptions, runExtension } from "./commands/extension";
import { runMcp } from "./commands/mcp";
import { runNativeHost } from "./commands/native-host";
import { runPencilUrl } from "./commands/pencil-url";
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

  // Open the channel console (its dashboard + the trace debugger) in the
  // session browser, for a picked running channel.
  program
    .command("debug")
    .description("open the channel console (dashboard + trace debugger) in the session browser")
    .option("--mcp <tag>", "target a channel by registry tag (skips the selector)")
    .option("--no-open", "print the URL but don't open the browser")
    .action((opts: DebugOptions) => runDebug(opts));

  // Unlike its siblings, `aiui chrome` is a real subcommand (not a forwarding
  // wrapper): it manages the agent's browser — the managed-browser install
  // (Chromium or Chrome for Testing) and launch status.
  program
    .command("chrome")
    .description("manage the agent's browser: install | update | status")
    .argument("<action>", "install | update | status")
    .argument("[flavor]", "for install/update: chromium | chrome-for-testing (default: configured)")
    .action((action: string, flavor: string | undefined) =>
      runChrome(flavor === undefined ? [action] : [action, flavor]),
    );

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

  // The intent client extension's native side: the Chrome native-messaging
  // host that gives it channel discovery a browser can't get from the on-disk
  // registry.
  program
    .command("extension")
    .description("the intent client extension's native host: install-native-host | status")
    .argument("<action>", "install-native-host | status")
    .option("--extension-id <id>", "extension id for allowed_origins (default: the pinned id)")
    .action((action: string, opts: ExtensionOptions) => runExtension(action, opts));

  // The Chrome native-messaging host itself — spawned BY the browser, never by
  // hand: speaks length-prefixed JSON on stdio (stdout is frames-only).
  program
    .command("native-host", { hidden: true })
    .description("(internal) Chrome native-messaging host — spawned by the browser")
    .action(() => runNativeHost());

  // (There is no `aiui demo`. Scaffolding a playground is `create-aiui`'s job —
  // `npm create @habemus-papadum/aiui@latest my-app` — so there is exactly one
  // starter template in the repo, and it is the one people actually build on.)

  // Reset aiui's on-disk state to a fresh-install slate — the two cache roots
  // (this repo's .aiui-cache/ and the user cache, including the managed Chrome
  // for Testing). For clean demos of the install/first-run flow.
  program
    .command("clean")
    .description(
      "reset aiui state (project + user cache, incl. the managed browser) for a clean-slate demo",
    )
    .option("--project-only", "only this repo's .aiui-cache/")
    .option("--user-only", "only the user cache (~/.cache/aiui)")
    .option("--keep-browser", "keep the managed browser (skip the ~150-160 MB re-download)")
    .option("-n, --dry-run", "print what would be deleted, then stop")
    .option("-y, --yes", "delete without the confirmation prompt")
    .action((opts: CleanOptions) => runClean(opts));

  program
    .command("open")
    .description("open a URL in the session browser, e.g. `aiui open http://localhost:5173`")
    .argument("<url>", "the URL to open")
    .option("--profile <name>", "named profile under .aiui-cache/chrome/")
    .option("--data-dir <path>", "explicit Chrome user data dir")
    .action((url: string, opts: Pick<BrowserOptions, "profile" | "dataDir">) => runOpen(url, opts));

  // Shell activation, venv-style: `eval "$(aiui env)"` puts the project's
  // executable dirs on PATH and exports the root .env/.env.dev files into the
  // current shell (shell code on stdout, human summary on stderr).
  program
    .command("env")
    .description('print shell code to activate this checkout — use as: eval "$(aiui env)"')
    .action(() => runEnv());

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
  // in-process MCP server. The subcommands that launch a channel (`serve`,
  // `mcp`) additionally get this project's channel settings — `channel.bind`
  // and `sidecars.*` — resolved exactly as `aiui claude` resolves them, so a
  // standalone channel hosts the same sidecars and binds the same way
  // as a session's. See util/channel-launch.
  program
    .command("mcp")
    .description("run a channel command (forwards to aiui-claude-channel), e.g. `aiui mcp quick`")
    .allowUnknownOption()
    .allowExcessArguments()
    .helpOption(false)
    .argument("[args...]", "arguments forwarded to the aiui-claude-channel CLI")
    .action((args: string[]) => runMcp(args));

  // `aiui pencil …` — the remote pencil. `url` prints where the iPad should
  // point its browser: the pencil surface rides each channel's one web server
  // (`/pencil/` on the channel port), so this resolves every running channel
  // that answers `/pencil/info` — plus whether its bind makes it LAN-reachable —
  // so you can copy-paste the URL.
  const pencil = program
    .command("pencil")
    .description("the remote pencil — url (where the iPad should connect)");
  pencil
    .command("url")
    .description("pick a channel + interface, print the iPad URL and copy it to the clipboard")
    .option("--json", "machine-readable targets (every hosting channel, no prompts)")
    .action((opts: { json?: boolean }) => runPencilUrl(opts));

  return program;
}
