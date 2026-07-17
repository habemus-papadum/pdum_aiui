---
name: aiui-workflow
description: Use inside an `aiui claude` session (or any aiui project) when the user asks how their aiui system is set up, what's running, or how to configure it — which browser/Chrome-for-Testing is in play, what other channel servers exist, what the config options are and where they're set. Teaches live introspection commands; never answer these questions from memory or baked docs.
---

# aiui workflow — introspect the running system

If this session exists, the launcher's preflight already ran: `aiui claude` resolved a
browser, spawned the channel MCP server, and checked the API keys in its environment
(warning on stderr about anything missing or rejected). So don't re-derive the setup from
first principles — **ask the running system**. Every fact below has a live source; prefer
running the command to describing it, and prefer quoting its output to paraphrasing it.

All `aiui` commands below work from a terminal in the project. In a dev checkout of
pdum_aiui itself, `pnpm aiui <cmd>` or `./aiui <cmd>` are the same CLI run from source.

## Who am I? (this session's channel)

- **`channel_info` MCP tool** (in this session, no args) — this channel's tag, pid, port,
  cwd, and the Claude session that owns it. Call this first; its `port` unlocks the HTTP
  routes below.
- **`GET http://127.0.0.1:<port>/health`** — liveness, bind, generation, page-tools and
  session-hub counts. CORS-readable.
- **`GET http://127.0.0.1:<port>/debug/api/info`** — the full self-description: channel
  info plus `launch`, the launcher's own record of how this session was assembled — how
  the Chrome DevTools MCP was wired (attach vs launch, endpoint, profile, extension) and
  the key preflight outcomes (`launch.openaiKey`, `launch.geminiKey`:
  valid / invalid / missing / unverified). This is the first place to look when browser
  tooling or the voice pipeline misbehaves.

## What browser is this? (Chrome for Testing)

- **`aiui chrome status`** — the one command: the managed Chrome-for-Testing install and
  its version (`installed <buildId>`, whether it's latest stable), the executable path,
  what a launch from *this directory's* config would do, and devtools-panel availability.
- `aiui chrome install` / `update` — idempotent "ensure latest stable" (managed install
  lives under `~/.cache/aiui/chrome/`).
- `aiui chrome extension` — prints the aiui DevTools extension directory (for Load
  unpacked).
- Which browser the *session* actually attached to is in `/debug/api/info` →
  `launch.chromeDevtools` (don't guess from config — attach mode may have found an
  already-running session browser).

## What else is running? (other channels)

Every channel server — real sessions and debug ones (`serve`) — registers
itself in `~/.cache/aiui/mcp/<pid>.json` (dead entries are pruned on read). To enumerate:

- **`aiui paint url --json`** — every running paint-capable channel with cwd, port, the
  owning Claude session's name, and whether it's LAN-reachable. The quickest "what aiui
  servers are up" view even if you don't care about the iPad.
- `cat ~/.cache/aiui/mcp/*.json` — the raw registry when you need every entry (including
  paint-less ones); each file is one server's tag/pid/ppid/port/cwd, `debug: true` marks
  servers with no agent attached.
- Selectors (`aiui vite`, `aiui mcp quick`) list the same set interactively.

## Configuration — never recite options from memory

The config schema is self-documenting and versioned with the code; the CLI renders it.
Do **not** enumerate options in prose from this file — run:

- **`aiui config show`** (or `--json`) — every key, its effective value, and **which file
  set it** (user config vs project `.aiui-cache/config.json`). This is the authoritative
  answer to "what are my options and what are they set to", including keys the user never
  touched (shown at their defaults, with docs).
- `aiui config get <key>` / `set <key> <value>` / `unset <key>` — dotted keys, validated
  against the schema (`--project` writes the project layer instead of the user's).
- `aiui config set-dsp` — opt into `--dangerously-skip-permissions` (appends it to `claude.args`).
- `aiui config tui` — the interactive browser, for humans exploring.

Two settings worth knowing exist (look them up with `config show` rather than trusting
this list to stay complete): `channel.bind` is asked once at first interactive run and
persisted, and `claude.args` carries extra argv passed to `claude` on every launch —
`--dangerously-skip-permissions` lives there, opt-in via `aiui config set-dsp` and off by
default. `chrome.*` controls browser mode/enablement. API keys are deliberately **not**
config — they come from the environment `aiui claude` is launched in (see the preflight
statuses above).

## When something's wrong

- **Channel diagnostic log**: each channel process appends lifecycle + every error push to
  `.aiui-cache/logs/channel-<stamp>-<pid>.jsonl` (project-local, path also printed on the
  channel's startup stderr line). Read it post-mortem when a page reported an error that's
  since vanished.
- **Lowering traces**: `.aiui-cache/traces/`, browsable at
  `http://127.0.0.1:<port>/debug` (or `aiui debug` standalone).
- `aiui clean` resets aiui's on-disk state (project and/or user cache) for a fresh-install
  demo — destructive, confirm with the user first.

## Deeper docs

For the *why* behind the setup (security posture, browser modes, remote development), read
these rather than restating them here:
[getting-started.md](../../../../../../../docs/guide/getting-started.md),
[chrome.md](../../../../../../../docs/guide/chrome.md),
[config.md](../../../../../../../docs/guide/config.md),
[warning.md](../../../../../../../docs/guide/warning.md). (In the pdum_aiui repo these links
are the live guide docs; in a packaged install they point at copies bundled with this skill.
Published at https://habemus-papadum.github.io/pdum_aiui/.)
