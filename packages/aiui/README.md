# @habemus-papadum/aiui

ai ui frontends — the `aiui` CLI: launchers and browser plumbing for an
agent-in-the-loop UI workflow. ⚠️ Read the repo's *Read before running* guide first: `aiui claude`
gives the agent a browser by default, and can skip permissions if you opt in
(`aiui config yolo`).

## Install

```sh
npm install @habemus-papadum/aiui
```

## CLI

```sh
aiui claude      # launch Claude Code wired with the aiui channel, plugins, and browser MCP
aiui dashboard   # open the channel console in the session browser
aiui channels    # every running channel server (and unclaimed Claude sessions)
aiui open <url>  # open a URL as a tab in the session browser (starts one if needed)
aiui chrome      # the managed browser binaries: install | update | status
aiui profile     # browser profiles (the unit of browser identity): list | new | rm | adopt
aiui keys        # vendor API keys in the OS vault: status | interview | set | unset
aiui config      # the config file: show | get | set | unset | tui | yolo
aiui remote <h>  # remote development's local half (browser tunnel + channel proxy)
aiui mcp         # forward to the aiui-claude-channel CLI (e.g. `aiui mcp quick`)
aiui --help
```

To create an app to point all of this at, use the scaffolder rather than the CLI:

```sh
npm create @habemus-papadum/aiui@latest my-app
```

Flags for `aiui claude` beginning with `--aiui-` are consumed by aiui (`--aiui-bind`,
`--aiui-no-session-browser`, `--aiui-profile <name>`, `--aiui-tag <tag>`, …); everything else
forwards to `claude` verbatim. `--help`/`--version` are inert: aiui prints its own answer,
then the wrapped tool's follows — no config, browser, or managed-install activity. Durable
settings live in the one user-level `~/.cache/aiui/config.json` — see the repo's
*Configuration* guide.

Built with [commander](https://github.com/tj/commander.js) for the command tree and
[execa](https://github.com/sindresorhus/execa) to spawn the child processes. The command
implementations live in `src/commands/`.

During development, run the CLI straight from source (via `tsx`, no build) with the
`bin/aiui` launcher at the repo root:

```sh
./bin/aiui claude
./bin/aiui --help
```
