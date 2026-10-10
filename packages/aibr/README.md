# @habemus-papadum/aibr

`aibr` manages persistent browsers that humans and agents can share, and launches Claude Code
or Codex with a single Chrome DevTools MCP server attached to the chosen browser. The launcher
execs the agent: the agent takes over its PID and terminal. Persistent browsers survive agent exit; temporary browsers belong to the agent’s MCP process.

Requires Node 24.5+ on macOS or Linux, and the agent CLI on `PATH`. It uses Node's experimental
`process.execve`; there is no resident Node wrapper around the agent. Browser downloads depend
on the browser vendor's platform availability; an explicit executable is also supported.

## Start here

```sh
npm install @habemus-papadum/aibr
# Or install globally to put aibr on PATH:
npm install -g @habemus-papadum/aibr

aibr doctor                 # inspect this machine; offer to fill in missing setup
# Or walk through the steps yourself:
aibr browser install        # choose Chromium or Chrome for Testing
aibr profile create         # guided profile settings (name defaults to "default")
aibr init --profile         # choose a profile for this project directory
aibr claude                 # use the project selection, or your saved default
aibr codex
```

In this repository, use `./bin/aibr` in place of `aibr` to run live source. The installed binary
uses `dist/cli.js`; `pnpm -C packages/aibr build` builds it. No browser is downloaded during
package installation or ordinary agent launch.

## Find what is available

```sh
aibr browser list           # downloaded builds, selected versions, executable paths
aibr profile list           # names, paths, ports, window/media settings, extensions, status
aibr profile show --profile # choose a profile and show its settings
aibr profile edit           # choose a profile and edit current values
aibr profile show research --json # raw metadata for scripts
aibr doctor                 # full inventory, default selection, missing pieces, setup offers
aibr doctor --no-prompt     # inspect only
aibr doctor --json          # structured report; always read-only
aibr browser list --json
aibr profile list --json
```

`browser list` inventories **aibr's download cache**; existing custom browser executables
appear with their profiles in `profile list` and `doctor`. `doctor` reports Node/exec support,
Claude and Codex executable paths, the bundled MCP, storage paths, installed builds, profile
parameters and status, saved agent arguments/YOLO settings, user and project defaults, targets,
and provider commands. It does not run providers, probe remote endpoints, download updates,
start browsers, or change agent-global MCP registrations while inspecting.

In a terminal, `doctor` offers to create a missing default profile (or choose an existing one)
and install browsers that profiles need. Each change is a yes/no choice. `--no-prompt`, `--json`,
and piped/noninteractive invocations report only. Invalid configuration is reported and preserved.

See the [command reference](docs/commands.md) for each command's purpose, effects and examples.

## Saved agent options and YOLO

One command enables the same defaults as the `clad` and `cod` shell aliases:

```sh
aibr config yolo on
# Claude: --dangerously-skip-permissions
# Codex:  --dangerously-bypass-approvals-and-sandbox

aibr claude
aibr codex

aibr config yolo off                  # both agents
aibr config yolo on --agent claude    # just Claude
```

YOLO is off until configured. It changes only the arguments aibr supplies to future launches;
it does not edit Claude/Codex settings or shell aliases. Setting YOLO off removes a saved copy
of the corresponding bypass flag as well. The command prints exactly which flags it enables.

Save arbitrary native arguments as an array, preserving shell quoting:

```sh
aibr config args claude -- --model opus
aibr config args codex -- --no-alt-screen
aibr config args codex                 # clear saved Codex arguments
aibr config show

aibr claude --no-yolo                  # opt out for this invocation
aibr codex --no-default-args           # skip saved args AND saved YOLO
aibr codex --no-default-args --yolo     # YOLO, without other saved args
aibr codex -- --model some-model       # pass native arguments after --
```

Saved arguments precede native arguments. For flags the underlying CLI does not allow to be
repeated, use `--no-default-args` when replacing a saved value. aibr reserves its browser MCP
configuration flags; unrelated native configuration overrides are allowed.

## Profiles and browsers

`profile create` first offers a local browser or an endpoint connection. Local settings include
name, browser family or executable, data directory, explicit or automatically assigned debugging
port, headless/not-headless mode, media permissions, unpacked extensions, extra Chrome arguments,
and an optional project-directory association. Endpoint profiles store one connection URL; the
interview accepts a URL, hostname and port, or a localhost port number. Flags prefill
answers. `--yes` uses the defaults without prompts; `--json` also implies `--yes`. Noninteractive
creation requires a name and uses defaults for other omitted settings.

```sh
aibr profile create research                  # guided setup
aibr profile create research --use-here       # guided setup + .aiui.yaml in this directory
# Scripted examples (use different names if you already created these):
aibr profile create research --browser chromium --debug-port 9223 --yes
aibr profile create testing --browser cft --debug-port 0 --headless --yes
aibr profile create custom --executable /absolute/path/to/chromium
aibr profile adopt old --user-data-dir /absolute/existing/data --browser chromium

aibr profile list
aibr profile show research            # formatted settings and running mode
aibr profile edit research            # same questions, current values prefilled
aibr profile edit                     # choose a profile first
aibr profile set research --media standard
aibr profile set research --extension /absolute/path/to/unpacked-extension
aibr profile set research --chrome-arg=--disable-features=Example

aibr browser start research
aibr open --profile research https://example.com
aibr claude --profile research
aibr codex --profile research
aibr browser status research
aibr browser stop research
```

Local profiles store cookies and other browser state in a persistent user-data directory with an
`aibr-profile.json` marker. The marker binds it to a browser family or explicit executable.
Create another profile to change browser identity. All launchers using one profile share one
browser; different profiles isolate browser state. Each agent gets its own MCP process.

A profile receives a concrete free port at creation unless one is supplied. A saved port is
never silently changed on collision. `--debug-port 0` explicitly chooses an ephemeral port.
Fixed ports are discovered from the browser's own startup announcement; port-zero profiles
also use Chrome's `DevToolsActivePort`. Runtime records verify both the process identity and
the browser instance, rather than accepting any process that happens to occupy a port.

The `development` media preset (the default) auto-accepts camera/microphone and current-tab
capture requests, and enables autoplay. `--media standard` leaves those permissions to Chrome.
Changing launch options does not restart a running browser. The next launch reports that an
explicit stop/start is needed. `browser stop` closes the shared browser for everyone using it.

For an already-running external browser with a discovery file:

```sh
aibr claude --auto-connect --user-data-dir /absolute/path/to/data
```

This is attach-only and needs no aibr marker. A fixed-port external browser is selected with
`--endpoint`. Extensions load at browser start; Chromium and Chrome for Testing support unpacked
extension flags. Branded Chrome may require loading the extension manually. aibr validates
declared scripts but never builds extensions or installs a native messaging helper.

Explicit profile deletion: `aibr profile remove research --yes`. For managed local profiles it refuses a
verified live browser or a Chrome singleton lock, and permanently removes the cookies. For saved
endpoint/provider/external references it only removes the reference, keeping browser data.

## Editing and headless overrides

`profile edit [name]` uses the same launch-settings interview as creation. Enter keeps the
current value; extension and extra-argument lists offer keep, replace, and clear choices. With
no name, edit opens the profile chooser. Browser identity and the data directory stay fixed to
preserve the profile's cookies. Editing never restarts a browser. `--yes` applies only supplied
flags, for example `aibr profile edit research --headless --yes`.

Headless mode is a saved default, with one-launch overrides on `browser start`, `claude`, and
`codex`. To log in using a profile whose default is headless:

```sh
aibr browser start research --no-headless
# Log in, then close this shared browser explicitly:
aibr browser stop research
aibr browser start research             # saved headless default applies again
# Equivalent override when launching an agent:
aibr claude --profile research --no-headless
```

The override never changes the saved profile. A running browser with different requested
settings is left alone; aibr asks for an explicit stop/start. `profile show` displays both the
saved mode and the running mode. These flags are rejected for endpoint/provider profiles and
attach-only auto-connect, since aibr does not own those browsers' launch settings.

## Temporary browser sessions

```sh
aibr claude --temp                       # not headless
aibr codex --temp-headless
aibr claude --temp --browser chromium
aibr codex --temp-headless --browser cft
aibr codex --temp-headless --executable /absolute/path/to/chromium
```

Temporary mode bypasses the project and default profile and conflicts with all explicit browser
selectors, including `--profile`, `--endpoint`, `--user-data-dir`, and `--pick`. It uses the one
usable managed browser family automatically, or offers a chooser if several are installed.
Scripts must specify `--browser` or `--executable` when the choice is ambiguous. It never downloads
a browser. Browser/executable flags on agent commands apply only to temporary mode.

The launcher passes the pinned MCP `--isolated`, the executable, and headless mode. MCP creates a
unique temporary user-data directory and lazily launches Chrome when a browser tool is first
used. It uses a pipe rather than a debugging port. Normal MCP disconnect/shutdown closes that
browser and removes its temporary directory. Sessions do not share cookies or extensions, and
use the development media defaults. The agent still replaces the launcher process. A temporary
`--dry-run` prints this plan without needing or starting a running browser.

## Selecting a target

Selection precedence is: explicit flag or `--pick`, nearest ancestor `.aiui.yaml` / `.aiui.yml` /
`.aiui.json`, saved user default, then the local `default` profile. Exactly one explicit selector
is allowed. **Bare `--profile` opens the local/endpoint profile chooser.** Omitting `--profile` uses the normal
selection without a chooser. `--pick` additionally includes saved remote and discovered targets.
For commands with positional arguments, put those first (e.g. `aibr open https://example.com --profile`)
or use `--profile=name` so an optional option value cannot consume the positional argument.

Create a project selection without writing the file by hand:

```sh
aibr init --profile                           # choose an existing local or endpoint profile
aibr init --profile research                  # write .aiui.yaml in this directory
aibr init /path/to/project --profile research # select for another directory
aibr init --target desktop --format json      # select a saved remote target
aibr profile create lab --use-here /path/to/project # create AND associate
```

`init` writes a name reference; it never starts a browser or edits user/agent configuration. It
refuses to overwrite any project selection file in that directory. To change an existing
selection, edit its `browser.target`. The default stub is YAML:

```yaml
# Browser target for this directory and its descendants.
schemaVersion: 1
browser:
  target: research
```

The equivalent JSON (`--format json`) is:

```json
{
  "schemaVersion": 1,
  "browser": { "target": "research" }
}
```

The nearest project file supplies the entire selection. Invalid files and unknown profiles
fail rather than silently choosing another browser. Multiple supported files in the same directory
are an error; keep one format per directory. YAML accepts comments and rejects duplicate keys,
custom tags and aliases. Project files select names; executable
provider definitions live in user configuration. Relative explicit paths resolve from `--cwd`
or the current directory. Native Codex `-C`/`--cd` also affects project selection.

```sh
aibr config default research
aibr target add research --profile research
aibr codex --profile                 # choose among saved local and endpoint profiles
aibr codex --pick                    # also include remote/discovered targets
aibr status --discover
aibr explain codex --profile research
aibr codex --profile research --dry-run
```

`explain` reports selection provenance and a plan when the target is reachable. `--dry-run` for a persistent/endpoint profile
requires a reachable target and does not start a browser, establish a tunnel, or launch an agent.
The pickers use numbered terminal menus. Ctrl-C or end-of-input cancels. Noninteractive runs
need explicit option values or a configured default. Browser start/stop/status and profile
show/set accept `--profile` too; without a name or selector they use the project/user default.
`config default <target>` always requires a name and never opens a chooser.

## Remote browsers

Run the browser on the machine where the human uses it. Run MCP alongside the agent. The
connection between them carries CDP, using whatever tunnel or network your environment supplies.

```sh
# Browser machine:
aibr browser start research

# Agent machine, after arranging a forward to that browser:
aibr codex --connect-port 19223
aibr profile create desktop --endpoint http://127.0.0.1:19223 --yes
aibr config default desktop
aibr codex
```

Endpoint profiles are connections, whether they lead to this machine, an SSH tunnel, a mesh
address, or another host. Localhost ports are just a convenient way to enter a URL:

```sh
aibr profile create desktop --host localhost --port 19223 --yes
aibr profile create desktop --remote          # guided URL / host / port entry
aibr profile edit desktop                    # edit the saved URL
aibr claude --profile desktop
```

Choose one creation example for a given name. Endpoint profiles live in aibr's user config,
alongside existing saved targets; `target add` remains available for compatibility and providers.
They appear in `profile list`, `show`, `edit`, and the chooser. Removing one only forgets the
connection reference. Aibr verifies the endpoint before launching an agent, but never starts or
stops that browser. There is no separate local-port profile type.

`--connect-port` always means a loopback port on the **agent machine**. `--endpoint` also accepts
HTTP(S) and WS(S) URLs. The launcher verifies a CDP WebSocket, including through a forwarded HTTP
discovery endpoint. The generated MCP connection uses that verified browser instance; restarting
the browser requires relaunching the agent for fixed-endpoint sessions.

For SSH, mesh networks, rendezvous services, and interactive discovery, see the
[provider protocol and examples](docs/providers.md). Providers can establish independently
managed tunnels. aibr does not keep a launcher alive to supervise them or close them on agent
exit. There is no built-in SSH/Tailscale/rendezvous daemon in this version.

## Default MCP configuration outside aibr launches

There are two separate configurations. `aibr config …` saves this tool's user defaults (browser
target, native agent arguments, YOLO, providers); it never edits Claude or Codex configuration.
Registering an MCP server with `claude mcp add` / `codex mcp add` edits **the agent's** configuration,
so ordinary launches outside aibr get browser tools too. This registration is optional.


`aibr mcp` execs the pinned MCP dependency against an already-running browser. It never starts
a browser or establishes a tunnel and keeps stdout available for the MCP protocol.

```sh
aibr browser start default
claude mcp add --scope user chrome-devtools -- aibr mcp --profile default
codex mcp add chrome-devtools -- aibr mcp --profile default
```

Use an absolute aibr executable path if your agent's `PATH` does not contain it. Subsequent
`aibr claude`/`aibr codex` invocations override this same `chrome-devtools` entry for that
invocation, preserving unrelated servers and saved agent configuration. If your global browser
server uses another name, run `aibr config server-name that-name`. Differently named duplicate
servers are separate entries; consolidate their names yourself. Enforced administrator policies
still apply. Claude's optional `--exclusive-mcp` excludes other configured MCP servers.

## Installation and state

```sh
aibr browser check                 # check latest builds, without installing
aibr browser update chromium       # explicit update
aibr browser install cft --build <build-id>    # explicit build ID from browser check
aibr doctor
```

Chromium tracks snapshot revisions; Chrome for Testing tracks stable releases. Downloads and
updates are explicit. New builds install alongside old builds; running browsers retain their
original executable. There is no automatic browser-build pruning or profile migration.

| State | macOS | Linux |
| --- | --- | --- |
| Config | `~/Library/Application Support/aibr/config.json` | `$XDG_CONFIG_HOME/aibr/config.json` (defaults to `~/.config`) |
| Profiles | `~/Library/Application Support/aibr/profiles/` | `$XDG_DATA_HOME/aibr/profiles/` (defaults to `~/.local/share`) |
| Runtime records/logs | `~/Library/Application Support/aibr/state/` | `$XDG_STATE_HOME/aibr/` (defaults to `~/.local/state`) |
| Browser downloads | `~/Library/Caches/aibr/` | `$XDG_CACHE_HOME/aibr/` (defaults to `~/.cache`) |

`AIBR_HOME` overrides all four locations into `config.json`, `data/`, `state/`, and `cache/`
under one directory. Tests use it to avoid touching real profiles or configuration. Browser
downloads are disposable; profile data is not part of the cache. Nothing is shared implicitly
with the old aiui launcher's storage.

The Chrome DevTools MCP dependency is pinned in this package and resolved locally. No `npx`
download or latest-version resolution occurs at agent startup.

## Development and verification

```sh
pnpm -C packages/aibr build
pnpm -C packages/aibr typecheck
pnpm -C packages/aibr test

# Optional local compatibility checks; no model requests are sent:
AIBR_TEST_AGENTS=1 pnpm -C packages/aibr test
# Optional real-browser test; uses a fresh isolated headless profile:
AIBR_TEST_BROWSER=/absolute/path/to/chromium pnpm -C packages/aibr test
```

The default suite tests config precedence, concurrent profile launches, fixed/ephemeral ports,
stale records, independent browser lifetimes, forwarded CDP, provider failures, saved defaults,
and actual PID/argument/exit-code/signal behavior across `execve`. CI runs it on Linux and macOS.
The packaging gate installs the tarball and exercises the binary and dependency resolution.

Local compatibility was verified with Claude Code 2.1.296, Codex 0.162.1, Node 26.10.0, and the
pinned MCP 1.10.1. The optional tests make that verification repeatable as the agent CLIs change.

See [shared browser etiquette](docs/shared-browser.md) for instructions to give agents using a
profile alongside other agents or a human.
