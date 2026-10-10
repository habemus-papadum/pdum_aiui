# aibr command reference

`aibr` installs browsers, manages persistent browser profiles, and launches agents with browser
tools. An **installation** is a browser build. A **profile** is either a local directory of cookies and browser state with launch settings,
or a saved endpoint URL. Existing saved targets and provider references also appear in the profile
catalogue; the `target` commands remain available for aliases and providers.
Multiple agents can share a target.

Run `aibr --help`, `aibr <group> --help`, or `aibr <group> <command> --help` for flags.
In a checkout, substitute `./bin/aibr` for `aibr`.

## Set up and inspect

| Command | What it does |
| --- | --- |
| `aibr doctor` | Report tool paths, installations, profiles, settings, targets, providers, and user/project selection. In a terminal, offer to fill in missing local setup. |
| `aibr doctor --no-prompt` | Report only. Never install a browser or create a profile. |
| `aibr doctor --json` | Diagnostic inventory as structured JSON, always without prompts. |
| `aibr init [directory] --profile [name]` | Write a project selection file. Choose a profile if the name is omitted. Directory defaults to the current one. |
| `aibr init [directory] --target <name>` | Write a project selection for a saved local or remote target. |
| `aibr status [--discover] [--json]` | Summarize targets and managed installations. With `--discover`, run discovery providers. Saved endpoints may be probed. |
| `aibr explain [agent]` | Explain the selected target and its launch plan if reachable. No browser, tunnel or agent is started. Provider targets may invoke their read-only resolve operation. Agent defaults to Codex. |

`init` defaults to `.aiui.yaml`; use `--format json` or `--format yml` for another format.
It refuses to replace an existing file. Edit `browser.target` in that file to change the
selection. Descendants inherit the nearest project file. More than one supported file in the
same directory is an error. Project files contain name references only.

`doctor` inventories aibr's browser cache and configured custom executables. It does not search
every directory on the machine for unrelated browser apps, invoke providers, or probe remote
endpoints. Stopped profiles are normal; missing executables and invalid metadata are reported
separately. A damaged user config still produces a report. In a pipe or script, doctor never
prompts. Missing Claude/Codex executables are reported; automatic installation is only offered
for browsers.

## Browser installations and processes

| Command | What it does |
| --- | --- |
| `aibr browser list [--json]` | List every cached build, its executable path, and whether it is selected for new launches. No network access. |
| `aibr browser install [family] [--build <id>]` | Download a build and select it for that browser family. Omit the family for a Chromium/Chrome for Testing chooser. |
| `aibr browser update [family]` | Install and select the latest build; omit the family to choose. Retain older builds and running browsers. |
| `aibr browser check [family]` | Query upstream build availability without downloading or changing the selected build. |
| `aibr browser start [profile]` | Start the profile's browser, or reuse it if running. Return connection details. |
| `aibr browser status [profile]` | Report process/connection state and whether changed settings require a restart. |
| `aibr browser stop [profile]` | Explicitly close the shared browser for everyone using the profile. Preserve cookies and other data. |

Families are `chromium` (snapshot builds) and `chrome-for-testing` (stable releases, alias `cft`).
Downloads are explicit. Starting a browser or agent never downloads or updates a browser.
Each family has one selected build for future launches. Updating does not change an existing
process's executable. Its next start after stopping uses the selected build.

Start/status/stop also accept `--profile [name]` and `--user-data-dir <path>`. Bare `--profile`
opens the chooser. No profile argument uses the project/user default; a remote default requires
an explicit local profile for these process commands. Exiting an agent or attach-only MCP never stops a
persistent browser. Use stop followed by start to apply changed settings.

## Profiles

| Command | What it does |
| --- | --- |
| `aibr profile create [name]` | Choose local browser or endpoint, then walk through its settings. Create a local directory or save a URL. Never download or start the browser. |
| `aibr profile adopt [name] --user-data-dir <path>` | Add aibr metadata to an existing data directory, keeping its contents. Prompt for missing settings in a terminal. |
| `aibr profile list [--json]` | List local and endpoint profiles, saved parameters, paths, status and missing-browser errors. Keep damaged entries visible. |
| `aibr profile show [name] [--json]` | Show formatted parameters and running mode. Use `--json` for raw metadata. Bare `--profile` opens the chooser. |
| `aibr profile edit [name]` | Edit through the same interview as create, with current values prefilled. Omit name to choose. Enter keeps values; lists offer keep/replace/clear. |
| `aibr profile set [name] <options>` | Change saved launch options without restarting a browser. Also accepts `--profile [name]`. |
| `aibr profile remove <name> --yes` | Permanently delete a stopped managed profile, including cookies. Refuse a live browser or singleton lock. Saved endpoint/provider/external references are forgotten without deleting data or stopping browsers. |

Creation/adoption flags prefill interactive answers. With `--yes`, or outside a terminal,
unspecified settings take these defaults; a name must be supplied. `--json` prints the created
metadata instead of a readable summary and implies `--yes`.

| Setting | Flag | Default |
| --- | --- | --- |
| Browser | `--browser <family>` or `--executable <path>` | Managed Chromium |
| Directory | `--user-data-dir <path>` | Managed location; adopt requires an external path |
| Debugging port | `--debug-port <number>` | Free fixed port starting at 9222; `0` requests an ephemeral port |
| Mode | `--headless` / `--no-headless` | Not headless |
| Media permissions | `--media development` / `--media standard` | Development: auto-allow microphone, camera, current-tab capture and autoplay |
| Extensions | `--extension <directory>` (repeatable) | None |
| Extra browser flags | `--chrome-arg=--flag=value` (repeatable) | None |
| Project association | `--use-here [directory]` | None; flag without a directory uses the current directory |
| Project file format | `--format <yaml, yml or json>` | YAML |
| User default | `--default` | Do not change the saved default |

For an endpoint profile, use `--endpoint <url>`, or `--host <hostname> --port <port>`.
A port without a host uses localhost. `--remote` opens the endpoint interview, where full URLs,
hostnames and bare localhost ports are accepted. Only a URL is saved, regardless of how entered.
Endpoint profiles do not accept local browser/launch flags. Their process lifetime belongs to
the browser host. Existing `target add --endpoint` entries work as profiles without migration.

```sh
aibr profile create desktop --host localhost --port 19222 --yes
aibr profile show desktop
aibr profile edit desktop                 # URL prefilled
aibr profile edit desktop --port 19223 --yes # keep the existing host and protocol
aibr claude --profile desktop
```

`profile edit --yes` applies supplied flags only and keeps other values. For local profiles,
it supports `--clear-extensions` and `--clear-chrome-args`; for endpoints, `--endpoint`, `--host`,
and `--port`. Editing does not restart processes. Browser identity and data directory cannot
change during an edit. Provider references remain configured through the provider/target commands.

The wizard can associate the new profile with a project directory:

```sh
aibr profile create research --use-here /path/to/project
# Or fully scripted:
aibr profile create research --browser cft --media standard --debug-port 9223 --use-here --yes
```

Browser identity is immutable: create another profile to use a different family. `profile set`
supports port, window, media, extensions and extra arguments. Supplying extensions or extra
arguments replaces the corresponding list. `--clear-extensions` empties that list. Structured
options own debugging, directory, headless, media and extension flags; those cannot also be
extra arguments. Extension directories must contain a built unpacked extension; aibr does not
build extensions or install native messaging helpers.

## Launch and select

| Command | What it does |
| --- | --- |
| `aibr claude [selectors] -- <native arguments>` | Start/reuse the local browser (or resolve a remote connection), then exec Claude with its browser MCP configured. |
| `aibr codex [selectors] -- <native arguments>` | The same flow for Codex CLI. |
| `aibr open <url> [selectors]` | Start/reuse the browser and open a tab. Put the URL before bare `--profile`. |
| `aibr mcp [selectors]` | Exec the pinned Chrome DevTools MCP against an **already running** browser. Start no agent, browser or tunnel. Intended for agent-managed stdio subprocesses. |

Selectors are mutually exclusive: `--profile [name]`, `--target <name>`, `--user-data-dir <path>`,
`--endpoint <url>`, `--connect-port <port>`, or `--pick`. Bare `--profile` chooses a saved local or endpoint profile;
`--pick` includes remote/discovered targets. Omitting selectors never opens a chooser. It uses
the nearest project file, then the user default (initially the profile `default`).

`--connect-port` means a loopback port on the agent machine, including a forwarded port.
`--auto-connect` with `--profile` or `--user-data-dir` attaches through `DevToolsActivePort` and
does not start a browser. `--cwd` selects the directory for project lookup and agent launch.
Native Codex `-C`/`--cd` also affects project lookup.

Agent commands support `--dry-run` (require a reachable browser for persistent/endpoint modes; print the plan),
`--yolo` / `--no-yolo` (override saved permission bypass), and `--no-default-args` (skip saved
arguments and YOLO). Claude alone supports `--exclusive-mcp` to exclude other configured MCPs.
Ordinary launches override the same-name browser MCP while retaining unrelated MCP servers.

## Headless overrides and temporary mode

`browser start`, `claude`, and `codex` accept `--headless` and `--no-headless` for a managed local
profile. The override affects only this launch, preserving the saved default. If a running
browser has different requested settings, aibr requires an explicit stop/start. It never restarts
a shared browser automatically. `profile show` displays saved and actual running modes.

```sh
aibr browser start research --no-headless  # log in interactively
aibr browser stop research
aibr browser start research                # saved default again
aibr codex --profile research --headless    # equivalent override on agent launch
```

Overrides are rejected for endpoint/provider and auto-connect targets; those modes only attach.

| Agent launch option | What it does |
| --- | --- |
| `--temp` | Give MCP ownership of a fresh temporary browser, not headless by default. |
| `--temp-headless` | The same, headless. Conflicts with `--temp` and `--no-headless`. |
| `--browser chromium` / `--browser cft` | Temporary mode only: choose an installed managed family. |
| `--executable <path>` | Temporary mode only: use this executable instead. Conflicts with `--browser`. |

Temporary mode bypasses project/default selection and conflicts with explicit profile/endpoint
selectors. With one usable managed family, it is chosen automatically; with several, a terminal
chooser appears. Scripts must specify a browser when ambiguous. No browser is downloaded.

MCP receives `--isolated`, `--executable-path`, headless mode, and the development media flags.
It lazily starts the browser on the first browser tool call, using a pipe instead of a CDP port.
Each MCP gets its own temporary user-data directory. On normal stdin disconnect or shutdown,
MCP closes the browser and removes that directory. It inherits no profile cookies or extensions.
A temporary `--dry-run` prints a plan without starting MCP or a browser; no live endpoint is needed.

## Save defaults, targets and providers

| Command | What it does |
| --- | --- |
| `aibr config show` | Print aibr's user configuration and its path. |
| `aibr config default <target>` | Save the fallback target. Require a name; no chooser. Project files take precedence. |
| `aibr config server-name <name>` | Set the MCP name aibr supplies; match an existing global browser entry to override it. |
| `aibr config args <agent> -- <args>` | Replace saved native arguments for Claude/Codex. Omit arguments to clear. |
| `aibr config yolo [on/off] [--agent <agent>]` | Save permission bypass defaults. Defaults to both agents and mode on. |
| `aibr target add <name> --profile [profile]` | Save/replace a profile reference. Bare `--profile` opens the chooser. |
| `aibr target add <name> --endpoint <url>` | Save/replace an HTTP(S)/WS(S) CDP endpoint. |
| `aibr target add <name> --user-data-dir <path>` | Save/replace an external profile reference. |
| `aibr target add <name> --provider <provider> --id <id>` | Save/replace a provider target reference. |
| `aibr target list [--discover]` | List targets, optionally including discovery results. |
| `aibr target remove <name>` | Forget a target; do not delete browser data. |
| `aibr provider add <name> --command <executable> -- <args>` | Save/replace a discovery/tunnel adapter with literal arguments, no shell. |
| `aibr provider list` | Print provider definitions. |
| `aibr provider discover <name>` | Ask one provider for targets; do not open a tunnel. |
| `aibr provider remove <name>` | Forget a provider; do not stop its tunnels. |

All `aibr config` changes are confined to aibr. They do not edit shell aliases or Claude/Codex
settings. Registering `aibr mcp` in an agent's user configuration is separate and optional:
see [default MCP configuration](../README.md#default-mcp-configuration-outside-aibr-launches).
The [provider protocol](providers.md) explains custom SSH, mesh or rendezvous discovery.

## Terminal and script behavior

Prompts use numbered choices, explain defaults, retry invalid answers, and cancel with Ctrl-C
or end-of-input. Prompt output goes to stderr. Bare selectors and browser installation without
a family require a terminal. Creation/adoption use `--yes` for unattended defaults; doctor uses
`--no-prompt` for report-only operation. Inventories offer `--json` for structured output.

Configuration errors and command failures exit nonzero. Doctor returns a report even when it
finds missing optional tools or setup; scripts should inspect its JSON fields for readiness.
