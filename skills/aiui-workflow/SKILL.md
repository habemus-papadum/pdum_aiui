---
name: aiui-workflow
description: Use inside an `aiui claude` session (or any aiui project) when the user asks how their aiui system is set up, what's running, or how to configure it — which browser is in play, what other channel servers exist, what the config options are, where keys/traces/logs live. Teaches live introspection commands; never answer these questions from memory or baked docs.
---

# aiui workflow — introspect the running system

If this session exists, the launcher's preflight already ran: `aiui claude` resolved a
browser, spawned the channel MCP server, and resolved + validity-checked the vendor API keys
(a definitively rejected key aborts the launch; missing keys warn with what degrades). So
don't re-derive the setup from first principles — **ask the running system**. Every fact
below has a live source; prefer running the command to describing it, and prefer quoting its
output to paraphrasing it.

All `aiui` commands below work from a terminal in the project. In a dev checkout of
pdum_aiui itself, `pnpm aiui <cmd>` or `./bin/aiui <cmd>` are the same CLI run from source.

## Who am I? (this session's channel)

- **`channel_info` MCP tool** (in this session, no args) — this channel's registry entry:
  tag, pid, port, cwd, kind, and the owning Claude session when the join matched. Call this
  first; its `port` unlocks the HTTP routes below.
- **`GET http://127.0.0.1:<port>/health`** — liveness: pid, generation, `host` (the bind
  address — loopback vs LAN), `interfaces` (the LAN IPv4s), `pageTools` and `session`
  summaries. CORS-readable from any page.
- **`GET http://127.0.0.1:<port>/debug/api/info`** — the full self-description: channel
  info plus `launch`, the launcher's own record of how this session was assembled — how
  the Chrome DevTools MCP was wired (`launch.chromeDevtools`: attach vs launch, browserUrl,
  profile, extensions) and all three key presence outcomes (`launch.openaiKey`,
  `launch.geminiKey`, `launch.elevenlabsKey`: present / missing — presence only, validity is
  never probed at launch).
  This is the first place to look when browser tooling or the voice pipeline misbehaves.
- **The console dashboard** — `aiui dashboard` (or open `http://127.0.0.1:<port>/`, which
  redirects to `/__aiui/`) renders the same facts as a page: channel + launch + browser
  info, key statuses, live page-tool/session counts, per-interface pencil URLs.

## What browser is this?

- **`aiui chrome status`** — the one command: the managed browsers per flavor (Chromium is
  the default; `chrome-for-testing` the alternate), each with installed build vs latest
  stable; the startup-check mode (`chrome.manage`); the default profile — its user data
  dir, which browser its marker names, and whether a session browser is already running —
  and the intent-client extension bundle the launcher auto-loads.
- `aiui chrome install|update [chromium|cft]` — idempotent "ensure latest stable"; managed
  installs live under `~/.cache/aiui/chromium/` and `~/.cache/aiui/chrome/`.
- `aiui profile list|new|rm|adopt` — browser identity belongs to **profiles** now (a
  marker file inside `~/.cache/aiui/userdata/<name>/`), not to config keys.
- Which browser the *session* actually attached to is in `/debug/api/info` →
  `launch.chromeDevtools` (don't guess from config — attach mode may have found an
  already-running session browser).

## What else is running? (other channels)

Every channel server — real sessions, `serve` debug servers, and `aiui remote` tunnels —
registers itself in `~/.cache/aiui/mcp/<pid>.json` (`kind: "channel" | "debug" | "remote"`;
dead entries are pruned on listing). To enumerate:

- **`aiui channels`** (or `--json`) — every live channel: name, kind, port, cwd, and the
  owning Claude session — plus live Claude Code sessions that NO channel claims, so an
  unnamed channel never looks like a quiet fallback.
- `cat ~/.cache/aiui/mcp/*.json` — the raw registry when you need every entry.
- `aiui mcp quick` — pick a session interactively and send it a prompt.

## Configuration — never recite options from memory

One config file: `~/.cache/aiui/config.json`. (There is no project-level config layer any
more.) The schema is self-documenting and versioned with the code; the CLI renders it. Do
**not** enumerate options in prose from this file — run:

- **`aiui config show`** (or `--json`) — every key, its effective value, and its docs,
  including keys the user never touched (shown at their defaults).
- `aiui config get <key>` / `set <key> <value>` / `unset <key>` — dotted keys, validated
  against the schema.
- `aiui config tui` (or bare `aiui config`) — the interactive browser, for humans.
- **`aiui config yolo`** — the one explicit opt-in to the trusting posture: appends
  `--dangerously-skip-permissions` to `claude.args` AND sets `channel.bind: "host"`
  (LAN-reachable), after a stated-consequences confirmation. Nothing else sets either.

The schema is four sections (verify with `config show` rather than trusting this list to
stay complete): `claude.args` (extra argv passed verbatim to `claude` on every launch) and
`claude.enterNudge`; `channel.bind` (`loopback` default / `host` — deliberately never asked
at first run; `yolo` above is the only opt-in, and `--aiui-bind` overrides one launch);
`chrome.manage` (`prompt | auto | off`) and `chrome.headless`; and the `keys.*` decisions
(next section).

## API keys (OS vault)

Keys are **not** free-form config: `keys.openai|gemini|elevenlabs` hold only a decision —
`"vault"` or `"skip"` — and the secrets live in the OS vault (macOS keychain / Secret
Service). In a source checkout the environment (`.env`/direnv) wins and the vault fills
gaps; in an installed CLI the environment is ignored entirely, so keys never enter the
agent's env. Manage with **`aiui keys`**: `status` (mode, per-provider decision and
effective source — never the values), `interview`, `set <provider>` (masked prompt,
round-trip verified), `unset <provider>`. `aiui claude` gap-fills undecided providers on
interactive launches and validity-checks found keys against each vendor's cheapest
endpoint: a rejected key aborts the launch; a missing OpenAI or ElevenLabs key warns with
exactly what degrades.

## When something's wrong

- **Channel diagnostic log**: each channel process appends lifecycle + every error push to
  `~/.cache/aiui/projects/<slug>-<hash8>/logs/channel-<stamp>-<pid>.jsonl` (the project
  cache is keyed by the project's absolute path; the exact log path is printed on the
  channel's startup stderr line). Read it post-mortem when a page reported an error
  that's since vanished.
- **Lowering traces**: `~/.cache/aiui/projects/<slug>-<hash8>/traces/`, browsed at
  `http://127.0.0.1:<port>/__aiui/debug` (the console's trace debugger, also embedded in
  the intent panel). `GET /debug` on the channel returns JSON pointers, not a page — the
  channel serves no HTML; every page is a sidecar on the same port (`/__aiui`, `/intent/`,
  `/pencil/`; the bar relay's `/bar` routes are data/WS only).
- If the channel's own source was edited, the `channel_reload` MCP tool rebuilds its
  lowering layer in place — see the session-browser skill for its depth boundary.
- `aiui clean` resets aiui's user-level cache — config, registry, profiles, managed
  browsers, and this project's traces/logs (`--project-only`, `--keep-browser`,
  `--dry-run`) — destructive, confirm with the user first.

## Deeper docs

For the *why* behind the setup (security posture, browser modes, remote development), read
these rather than restating them here:
[getting-started.md](../../docs/guide/getting-started.md),
[chrome.md](../../packages/aiui/docs/chrome.md),
[config.md](../../docs/guide/config.md),
[warning.md](../../docs/guide/warning.md). (This plugin ships as the whole pdum_aiui repo,
so these links are the live guide docs wherever the skill runs.
Published at https://habemus-papadum.github.io/pdum_aiui/.)
