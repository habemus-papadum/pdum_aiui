# @habemus-papadum/aiui

ai ui frontends — the `aiui` CLI: launchers and browser plumbing for an
agent-in-the-loop UI workflow. ⚠️ Read the repo's *Read before running* guide first: `aiui claude`
skips permissions by default and gives the agent a browser.

## Install

```sh
npm install @habemus-papadum/aiui
```

## CLI

```sh
aiui claude    # launch Claude Code wired with the aiui channel, plugin, and browser MCP
aiui vite      # launch Vite against the running channel (sets VITE_AIUI_PORT)
aiui browser   # start (or find) the shared session browser; --tunnel <host> = remote-dev local half
aiui open <url># open a URL as a tab in the session browser
aiui chrome    # manage the browser: install | update | status | extension
aiui mcp       # forward to the aiui-claude-channel CLI (e.g. `aiui mcp quick`)
aiui --help
```

To create an app to point all of this at, use the scaffolder rather than the CLI:

```sh
npm create @habemus-papadum/aiui@latest my-app
```

Flags for `aiui claude` beginning with `--aiui-` are consumed by aiui (`--aiui-no-chrome`,
`--aiui-chrome-profile <name>`, `--aiui-tag <tag>`, …); everything else forwards to `claude`
verbatim. `--help`/`--version` are inert: aiui prints its own answer, then the wrapped tool's
follows — no config, browser, or Chrome-for-Testing activity. Durable settings live in
`config.json` (user cache + project `.aiui-cache/`) — see the repo's *Configuration* guide.

Built with [commander](https://github.com/tj/commander.js) for the command tree and
[execa](https://github.com/sindresorhus/execa) to spawn the child processes. The command
implementations live in `src/commands/`.

During development, run the CLI straight from source (via `tsx`, no build) with the
`./aiui` launcher at the repo root:

```sh
./aiui claude
./aiui --help
```
