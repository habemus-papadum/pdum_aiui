import { Command } from "commander";
import { type OpenOptions, runOpen } from "./commands/browser";
import { runChrome } from "./commands/chrome";
import { runClaude } from "./commands/claude";
import { type CleanOptions, runClean } from "./commands/clean";
import {
  runConfigGet,
  runConfigSet,
  runConfigSetDsp,
  runConfigShow,
  runConfigUnset,
  type ShowOptions,
} from "./commands/config";
import { runConfigTui } from "./commands/config-tui";
import { type DebugOptions, runDebug } from "./commands/debug";
import { type ExtensionOptions, runExtension } from "./commands/extension";
import { runMcp } from "./commands/mcp";
import { type ProfileBrowserFlags, runProfile } from "./commands/profile";
import { type RemoteOptions, runRemote } from "./commands/remote";

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

  // The whole local half of remote development: local browser + one ssh
  // connection carrying both forwards + a kind:"remote" registry entry that
  // lives as long as this command (docs/proposals/aiui-registry.md §5).
  program
    .command("remote")
    .description(
      "connect this machine's browser + intent client to an `aiui claude` on another host",
    )
    .argument("<host>", "[user@]host of the remote box (an ssh target)")
    .option(
      "--port <port>",
      "preferred LOCAL channel-proxy port, walked when taken (default: 49300)",
    )
    .option(
      "--browser-port <port>",
      "preferred REMOTE port for the browser debug forward, walked when taken (default: 9222)",
    )
    .option("--name <name>", "display name for the registered remote channel")
    .option("--profile <name>", 'browser profile (default: the shared "default" profile)')
    .option("--data-dir <path>", "explicit Chrome user data dir")
    .option("--headless", "launch the browser with no UI")
    .option(
      "--reconnect",
      "replay a recorded connection (same tag/ports) after an ssh drop — the remote session must still be running",
    )
    .action((host: string, opts: RemoteOptions) => runRemote(host, opts));

  // Browser profiles: user-data dirs under ~/.cache/aiui/userdata/<name>,
  // each carrying an immutable marker that names its browser — the ONLY
  // browser-selection input (docs/proposals/browser-profiles.md). `chrome`
  // manages binaries; `profile` manages the dirs that reference them.
  program
    .command("profile")
    .description("manage browser profiles: list | new <name> | rm <name> | adopt <name>")
    .argument("<action>", "list | new | rm | adopt")
    .argument("[name]", "the profile name (lowercase slug)")
    .option("--chromium", "new/adopt: the managed Chromium (the default browser)")
    .option("--cft", "new/adopt: the managed Chrome for Testing")
    .option("--channel <channel>", "new/adopt: a branded Chrome release channel")
    .option("--executable <path>", "new/adopt: an explicit browser binary")
    .action((action: string, name: string | undefined, opts: ProfileBrowserFlags) =>
      runProfile(action, name, opts),
    );

  // The intent client extension's native side: the Chrome native-messaging
  // host that gives it channel discovery a browser can't get from the on-disk
  // registry.
  program
    .command("extension")
    .description("the intent client extension's native host: install-native-host | status")
    .argument("<action>", "install-native-host | status")
    .option("--extension-id <id>", "extension id for allowed_origins (default: the pinned id)")
    .action((action: string, opts: ExtensionOptions) => runExtension(action, opts));

  // (The Chrome native-messaging host is no longer a subcommand: it ships as
  // a COMPILED binary with @habemus-papadum/aiui-registry, installed by the
  // launchers / `aiui extension install-native-host`.)

  // (There is no `aiui demo`. Scaffolding a playground is `create-aiui`'s job —
  // `npm create @habemus-papadum/aiui@latest my-app` — so there is exactly one
  // starter template in the repo, and it is the one people actually build on.)

  // Reset aiui's on-disk state to a fresh-install slate — everything lives
  // under the user cache now (projects/<slug> for per-project state). For
  // clean demos of the install/first-run flow.
  program
    .command("clean")
    .description(
      "reset aiui state (the user cache, incl. profiles + managed browsers) for a clean-slate demo",
    )
    .option("--project-only", "only this project's cache (~/.cache/aiui/projects/<slug>)")
    .option("--user-only", "only the whole user cache (~/.cache/aiui)")
    .option("--keep-browser", "keep the managed browser (skip the ~150-160 MB re-download)")
    .option("-n, --dry-run", "print what would be deleted, then stop")
    .option("-y, --yes", "delete without the confirmation prompt")
    .action((opts: CleanOptions) => runClean(opts));

  program
    .command("open")
    .description("open a URL in the session browser, e.g. `aiui open http://localhost:5173`")
    .argument("<url>", "the URL to open")
    .option("--profile <name>", 'browser profile (default: the shared "default" profile)')
    .option("--data-dir <path>", "explicit Chrome user data dir")
    .action((url: string, opts: OpenOptions) => runOpen(url, opts));

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
    .description("every key with its value (or default)")
    .option("--json", "machine-readable: the file path and its parsed contents")
    .action((opts: ShowOptions) => runConfigShow(opts));
  config
    .command("get")
    .description("print a key's effective value (provenance goes to stderr)")
    .argument("<key>", 'dotted key, e.g. "channel.bind"')
    .action((key: string) => runConfigGet(key));
  config
    .command("set")
    .description("set a key in the config")
    .argument("<key>", 'dotted key, e.g. "channel.bind"')
    .argument(
      "<value>",
      "the new value, validated against the schema (arrays as JSON, e.g. '[\"--foo\"]')",
    )
    .action((key: string, value: string) => runConfigSet(key, value));
  config
    .command("set-dsp")
    .description("opt in to --dangerously-skip-permissions: add it to claude.args (idempotent)")
    .action(() => runConfigSetDsp());
  config
    .command("unset")
    .description("remove a key from the config")
    .argument("<key>", 'dotted key, e.g. "claude.args"')
    .action((key: string) => runConfigUnset(key));

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

  // (The `vite`, `env`, `pencil`, and `browser` commands are retired: apps run
  // plain `vite`; direnv replaced shell activation; the pencil URL lives on
  // the console dashboard (`aiui debug`); and `aiui open` subsumes `browser`
  // via the shared find-or-start pipeline.)

  return program;
}
