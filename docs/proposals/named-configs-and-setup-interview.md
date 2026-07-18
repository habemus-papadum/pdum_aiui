# Named configurations and the setup interview

Status: **PROPOSED** (2026-07-18). No code yet. This proposal grew out of a concrete, cosmetic
bug — a startup warning — but the fix for it forces a larger, overdue question: how does a user
*set up* an aiui project, given how many system-specific, vendor-specific, and taste-specific
choices a working session depends on? The answer proposed here is a **named configuration** plus
an **interactive setup interview** that stands the configuration up.

## The bug that started this

Launching `aiui claude` prints, in the startup banner:

```
▎ Channels (experimental) messages from server:aiui, server:aiui inject directly in this session · restart
▎ without --dangerously-load-development-channels to stop
▎ server:aiui · no MCP server configured with that name
▎ server:aiui · no MCP server configured with that name
```

The channel still works — this is cosmetic — but the message is real and worth understanding.

### Root cause (established experimentally)

`aiui claude` opts the session into the channel with
`--dangerously-load-development-channels server:aiui` (`packages/aiui/src/commands/claude.ts:210`).
Claude Code resolves that `server:<name>` reference **only against MCP servers it discovers on its
own** — a project-root `.mcp.json`, or the per-project section of `~/.claude.json`
(`projects[<cwd>].mcpServers`). We instead hand the channel server to Claude through
**`--mcp-config`** (inline JSON, `claude.ts:183` / `:205`). Servers supplied that way are invisible
to the development-channel resolver, so `server:aiui` fails to resolve → the warning. The channel
*works anyway* because the `--mcp-config` server connects normally and its `claude/channel`
capability registers the notification listener regardless of the `server:` reference.

Verified with a stub channel server against Claude Code 2.1.212 (three tmux runs of the real
interactive banner):

| Form | How the server reaches Claude | Warning? |
| --- | --- | --- |
| mirrors aiui today | `--mcp-config '<inline JSON>'` | **yes** — `no MCP server configured with that name` |
| doc-recommended | project-root `.mcp.json` (no `--mcp-config`) | **no — clean** |
| file variant | `--mcp-config <path/to.json>` | **yes** — same as inline |

The official [Channels reference](https://code.claude.com/docs/en/channels-reference) confirms the
intended shape: its walkthrough registers the server in `.mcp.json` *first*, then runs
`claude --dangerously-load-development-channels server:webhook`. The two documented value forms are
`server:<name>` (a bare `.mcp.json` server) and `plugin:<name>@<marketplace>` (a plugin-packaged
channel). See also the related upstream issue
[anthropics/claude-code#71792](https://github.com/anthropics/claude-code/issues/71792) (bare
`server:` channels parsed-but-not-registered — a different symptom: dropped notifications, which
is *not* ours). The doubled `server:aiui, server:aiui` line reproduced in every variant including
the clean one, so it is a separate upstream banner quirk to file, not something this proposal
fixes.

### The tension

The fix is "put the `aiui` entry in a file Claude discovers itself." But our channel command is
**not static** — it is assembled per launch and depends on how the system is running. Here is
exactly what we pass to the channel `mcp` subcommand today (`claude.ts:136–181`):

| What | Source | Truly per-session? |
| --- | --- | --- |
| program: `tsx …/cli.ts mcp` (dev) or `node …/dist/cli.js mcp` (installed) | `resolvePackageCli` | No — *install-layout* constant per checkout |
| `--tag <uuid>` | `--aiui-tag`, else the server mints one | Identity only |
| `--bind loopback\|host` | `channel.bind` config | No — durable config |
| `--launch-info <json>` = `{launcher, chromeDevtools, openaiKey, geminiKey}` | resolved at launch | **Only `chromeDevtools` is genuinely dynamic**; the key fields are status the channel can re-derive from its inherited env |

The port is **not** an input: the channel self-assigns one and records it, with tag/pid/name, to
the runtime registry at `~/.cache/aiui/mcp/<pid>.json` (`aiui-claude-channel/src/registry.ts`),
which is how `quick`, the sidecars, and the remote bar find it. So the only datum that *must* be
handed in per session is the **live Chrome wiring** (which browser / debug endpoint), plus a tag.

That narrow requirement is what makes a static discovered entry possible — **if we stop putting
the dynamic bits in the command line and carry them out-of-band instead.**

## The mechanism

Three pieces, none of which put session-specific data into the discovered config file.

**1. A write-once, discovered `aiui` entry with a static command.** Setup writes the `aiui` server
into a location Claude auto-discovers, with no per-session argv:

```json
{ "mcpServers": { "aiui": {
    "command": "<launcher resolved once at setup>",
    "args": ["mcp"],
    "env": {
      "AIUI_CONFIG":       "${AIUI_CONFIG:-default}",
      "AIUI_SESSION_FILE": "${AIUI_SESSION_FILE:-}"
    } } } }
```

The only baked-in variability is the install-layout launcher path (dev `tsx` vs installed `node
dist`), resolved once — correct because this file is machine-local regardless. `.mcp.json`
supports `${VAR}` / `${VAR:-default}` expansion, so the file never has to be rewritten per launch.

**2. Environment carries the dynamism, so the file stays static.** `aiui claude` sets two env vars
before it `exec`s `claude`, and Claude propagates them to the spawned channel:

- `AIUI_CONFIG=<name>` — which **named configuration** to load (durable prefs; default `default`).
- `AIUI_SESSION_FILE=<unique path>` — a per-launch **live session descriptor** the launcher writes
  after it assembles the session (browser launched/discovered, keys preflighted). This is exactly
  today's `--launch-info` payload, written to a file instead of an argv string. A unique path per
  invocation is what keeps **concurrent sessions in the same project** isolated (the role
  `--tag` plays today).

**3. The channel reads env instead of argv.** The `mcp` subcommand, on startup, prefers
`AIUI_CONFIG` + `AIUI_SESSION_FILE` when present: load the named config for durable settings
(`bind`, etc.), load the session file for live wiring, then self-register in the runtime registry
as it does now. When neither is set it falls back to parsing `--tag`/`--bind`/`--launch-info` off
argv — so **CI, `aiui mcp serve`, the e2e harness, and `--aiui-tag` keep working unchanged**.

With the entry discovered, `aiui claude` **drops the channel from `--mcp-config`** and keeps only
`--dangerously-load-development-channels server:aiui`. `server:aiui` now resolves → the warning is
gone. (The Chrome DevTools MCP may stay in `--mcp-config` — it is not referenced by any `server:`
flag — or move alongside `aiui` later; out of scope here.)

Two costs to note honestly: writing into `~/.claude.json` means **merging** into Claude's own
config (never clobbering the rest of that file), and the first launch in a project still shows
Claude's one-time "New MCP server found in this project" consent. The
`--dangerously-load-development-channels` full-screen warning is unaffected and expected (it is
governed by the existing `enterNudge` ack path).

## Named configurations

Everything above hangs off a **named configuration**: a project-local bundle of the decisions a
working session depends on. Default name: `default`. Selected per launch with a new
`--aiui-config <name>` flag. Created and edited by the setup interview.

- **Storage.** `.aiui-cache/configs/<name>.json` (project-local, gitignored — the root
  `.gitignore` already covers `.aiui-cache/`). Live per-launch descriptors sit beside it, e.g.
  `.aiui-cache/configs/<name>/session-<pid>.json`, and are disposable.
- **Relationship to today's two-layer config.** The existing merge stays: user
  `~/.cache/aiui/config.json` (machine-wide taste) ← project `.aiui-cache/config.json` ← **named
  config** ← per-launch flags. The named config is a new, highest-precedence *project* layer that
  the interview owns; machine-wide preferences (default managed-Chrome flavor, key source hints)
  still live user-level so a second project inherits them.
- **What a named config holds.** MCP-config placement (see interview §2), the browser choice and
  data-dir/profile (§3), extra `claude.args` (§4), `channel.bind` (§5), and recorded
  key *status/hints* — never secrets (§1).
- **`--aiui-config <name>`** joins the existing `--aiui-*` family (`aiui-args.ts`) and simply sets
  `AIUI_CONFIG` for the launch. Unknown name in an interactive session → offer to run setup for it;
  non-interactive → error with the list of known names.

## The setup interview

Setup is **interactive and deliberate**, not a silent auto-materialization. `aiui claude` runs it
**only when the current (project, config-name) has not been set up** and the session is
interactive; otherwise launch proceeds straight through (and non-interactive/CI never prompts —
it uses today's argv path, unchanged). It is also directly invokable: `aiui setup [--aiui-config
<name>]`, and re-runnable to edit an existing config or stand up a new named one.

It absorbs and extends today's first-run questions (`first-run.ts` — bind, enterNudge), which
become sections here rather than a separate prompt.

### Scope detection (preamble)

Two setup scopes, detected up front so the interview only asks what is missing:

- **Machine scope** (once per machine, recorded user-level): `claude` on PATH and its version; the
  managed-browser install; vendor API keys; anything global. Re-running setup in a second project
  skips the machine questions already answered.
- **Project + config scope** (per project, per named config): MCP placement, browser choice,
  launch args, bind. Always asked for a config that does not exist yet.

The preamble states which named config it is building (`default` unless `--aiui-config`), what is
already satisfied, and what it is about to ask.

### §1 — Doctor: environment and prerequisites

Diagnose, explain, and warn — the "doctor-like behavior." Nothing here is stored as a secret; only
**status and hints** are recorded (mirroring the existing preflight contract, which deliberately
keeps *only* a status — never the key — so a degraded pipeline can be explained without holding the
secret; see `openai-preflight.ts` / `gemini-preflight.ts`).

- **Toolchain**: `claude` present + version; note the `ANTHROPIC_API_KEY`-vs-claude.ai-login
  precedence (the "connectors are disabled" banner is exactly this) so the user isn't surprised.
- **Vendor API keys** — scan the environment, report present / missing / malformed, and for each
  explain what it unlocks and what *degrades* without it, so a partial setup is a clear, informed
  choice rather than a mystery at runtime:
  - `OPENAI_API_KEY` — transcription + correction, the **default** pipeline. Missing → a real
    warning (the core path is degraded).
  - `GEMINI_API_KEY` — the realtime (Gemini Live) submode only. Missing → a quiet note; the
    default tiers are unaffected.
  - `ELEVEN_LABS_API_KEY` — the ElevenLabs realtime engine. Missing → a note.
  - Interactive setup may **verify** a present key against the vendor's cheapest authenticated
    endpoint (reuse `preflightOpenAiKey` / `preflightGeminiKey`, which already do this and cost
    nothing but a status code); non-interactive only notes presence.
  - Surface the `*_KEY_HINT` env vars as the "where do I get this" pointer, and link the guide
    rather than inventing copy. **Never** write a key into any config file; if the user wants
    persistence, point them at their own shell profile / `.envrc`.
- **Browser availability**: system Chrome, managed Chrome for Testing, managed Chromium — what's
  installed, what setup can fetch. Feeds §3.

Doctor is also runnable on its own (`aiui setup --doctor` or `aiui doctor`) for "why is my
pipeline degraded?" without touching config.

### §2 — MCP config placement (the load-bearing new question)

*Where* to register the discovered `aiui` entry. This is genuinely user- and situation-specific —
there is no safe default that fits everyone — so it must be asked:

- **Project-level, out-of-repo** — `~/.claude.json` under `projects[<root>].mcpServers.aiui`.
  Project-scoped, auto-discovered, **not in the repo** (no git noise, no clash with a user's own
  `.mcp.json`). Recommended default for most users.
- **In-repo `.mcp.json`** — versioned and shared with collaborators, or gitignored for a personal
  sandbox. Right when the wiring should travel with the project or when the user prefers everything
  visible in-tree.

Explain the trade-off, record the choice in the named config, and (either way) write/merge the
static entry from §The mechanism. Re-running setup can move it.

### §3 — Browser

Which browser the agent drives, reusing the existing `chrome.*` config
(`config-schema.ts`, `managed-browser.ts`):

- Engine: managed **Chromium** (current default) / managed Chrome for Testing / system Chrome /
  attach to an existing `browserUrl` / **none** (`chrome.enabled: false`).
- Mode: `attach` (shared, user-visible session browser) vs `launch` (MCP-private, lazy).
- Data directory / profile name — defaults to the config name, under `.aiui-cache/chrome/<name>/`,
  so named configs don't fight over one profile. This is the "user data directory" the setup owns.
- Offer to fetch/update a managed browser here (today's CfT/Chromium offer, folded in).

### §4 — Claude launch options

- Extra `claude.args` passed verbatim every launch — model pin, default `--resume` behavior, and
  notably `--dangerously-skip-permissions` (still opt-in, off by default; the interview is the
  natural place to make that dangerous choice deliberately, replacing the ad-hoc `aiui config
  set-dsp`).
- `enterNudge` (auto-dismiss the development-channel ack) — moved from `first-run.ts`.

### §5 — Network / bind

The existing trusted-LAN question (`first-run.ts`), reframed as a section: `loopback` (this
machine only) vs `host` (the whole unauthenticated surface on the LAN — iPad paint, `/debug`,
prompt injection). Ask it in the context of "do you want the remote/iPad surfaces?", since that is
what drives the answer.

### §6 — Confirm and write

Summarize every decision, then commit atomically: write `.aiui-cache/configs/<name>.json`,
write/merge the static `aiui` MCP entry to the §2 location, and mark this (project, config)
set up. Print the exact command to launch (`aiui claude` or `aiui claude --aiui-config <name>`).

## How it ties together

**Default case (easy).** First `aiui claude` in a fresh, interactive project: scope detection sees
no `default` config → runs the interview (machine + project scope). At the end, `default` exists,
the `aiui` entry is discovered, and the session launches clean — no warning. Every later
`aiui claude` sees `default` already set up, sets `AIUI_CONFIG=default` + a fresh
`AIUI_SESSION_FILE`, assembles the session, writes the descriptor, and launches — no prompts, no
warning. The user learned nothing new for the common path.

**Flexible case.** `aiui setup --aiui-config lab` builds a second named config — different browser,
different bind, different args, its own data dir. `aiui claude --aiui-config lab` attaches to it.
`aiui config ls` / `rm` (or `aiui setup --list`) manage them. Named configs are inspectable files,
reusable across launches, and isolated from each other.

**Non-interactive / CI (unchanged).** No TTY → no interview, no `~/.claude.json` mutation. The
launcher keeps today's inline `--mcp-config` + argv path, so the e2e harness, `--aiui-tag`, and
`aiui mcp serve` behave exactly as now (the cosmetic warning included — acceptable in CI). The
channel's argv fallback (§The mechanism, piece 3) is what preserves this.

## Open decisions

1. **Default MCP placement** — `~/.claude.json` per-project (recommended: no repo pollution) vs
   in-repo `.mcp.json`. The interview asks either way; this only sets the pre-selected option.
2. **Drop `openaiKey`/`geminiKey` from what's passed** and have the channel preflight them itself
   (it has the env) — shrinks the live descriptor to chrome-wiring + bind + tag and removes a
   redundant path. Recommended.
3. **`aiui setup` as a first-class command** vs folding it entirely into `aiui claude`'s first-run.
   Proposed: both — a real `aiui setup` command, auto-invoked by `aiui claude` when unconfigured.
4. **Migration of `first-run.ts`** — bind + enterNudge become interview sections. Keep the
   standalone first-run prompt as a thin shim for one release, or cut over directly?
5. **Concurrency key** — `AIUI_SESSION_FILE` per-pid path (proposed) vs reusing `--tag`. The env
   path avoids argv entirely and composes with the static entry; confirm nothing else keys on tag
   for descriptor lookup.

## Relationship to existing work

- Supersedes the narrow first-run interview (`packages/aiui/src/util/first-run.ts`) by absorbing
  its two questions into a fuller interview.
- Builds on the schema-driven config registry (`config-schema.ts`, `CONFIG_SECTIONS`) and the
  two-layer merge (`config.ts`); the named config is a new highest-precedence project layer, not a
  replacement.
- Reuses the key-preflight contract (`openai-preflight.ts`, `gemini-preflight.ts`) — status only,
  never secrets — as the doctor's key-checking core.
- Reuses the browser/profile machinery (`managed-browser.ts`, `chrome.ts`, `browser.ts`) for §3.
- Keeps the runtime registry (`aiui-claude-channel/src/registry.ts`) as the source of truth for
  port/tag discovery; nothing here changes how a running channel is found.
- Preserves the documented security posture (`docs/guide/warning.md`): skip-permissions stays
  opt-in and off by default, and the bind decision stays an explicit, informed choice — now made
  inside the interview instead of a bare prompt.

## Suggested build order

1. **De-risk the load-bearing assumption first**: write/merge a static `aiui` entry into
   `~/.claude.json` behind a flag, drop the channel from `--mcp-config`, add the channel's env
   fallback, and confirm via the tmux harness that the warning disappears and the channel still
   delivers. Nothing else depends on more than this working.
2. Named-config storage + `--aiui-config` + the `AIUI_CONFIG`/`AIUI_SESSION_FILE` carriers and the
   live-descriptor write.
3. The interview: scope detection, then §1–§6, reusing the preflight/browser/config pieces above.
4. Migrate `first-run.ts` into the interview; update `docs/guide/` (getting-started, config,
   chrome, remote) and `CLAUDE.md`'s security-posture paragraph.
</content>
</invoke>
