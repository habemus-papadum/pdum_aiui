# Configuration

Everything that shapes aiui's behavior, in one place: the `config.json` files, the CLI flags that
override them, the environment variables, and the bits of on-disk state that drive prompting.

## How it works

Settings resolve through a fixed ladder — the first level that speaks, wins:

1. **CLI flags** (`--aiui-*` on `aiui claude`; the options of `aiui browser`/`aiui open`) — one
   launch only.
2. **Project config** — `.aiui-cache/config.json` under the directory the command runs in.
3. **User config** — `config.json` at the user cache root (see
   [environment variables](#environment-variables) for where that is).
4. **Built-in defaults.**

The two config files are merged **per key** (a project file that only sets `chrome.profile`
still inherits your user-level `chrome.forTesting`). Put personal defaults (your Chrome for
Testing preference, `skipPermissions`) at the user level and project specifics (a dedicated
profile, headless, a remote `browserUrl`) in the project file.

Two asymmetries to know about:

- **CI wins over config for the browser**: under a truthy `CI` env var the Chrome DevTools MCP
  defaults off regardless of `chrome.enabled` — only an explicit `--aiui-chrome` flag brings it
  up there.
- **aiui writes the user config too**: the **first interactive launch asks** for the settings
  that deserve a deliberate answer — skip permissions? auto-dismiss the channel prompt? — and
  persists them as `claude.skipPermissions` / `claude.enterNudge`; Chrome for Testing prompt
  answers ("automatically", "never ask again") persist as `chrome.forTesting` the same way.
  Always the *user* file — never the project file, which may be shared or committed by a team.

## The files

| Level   | Path                                                                        |
| ------- | --------------------------------------------------------------------------- |
| user    | `~/.cache/aiui/config.json` (respects `AIUI_CACHE` and `XDG_CACHE_HOME`)     |
| project | `.aiui-cache/config.json`, under the directory where the command runs        |

## Checking and editing: `aiui config`

You never have to open those files by hand — every key is browsable and editable from the CLI,
rendered from the same schema the loader validates against (so what the commands show is exactly
what a launch would accept):

```sh
aiui config              # the interactive browser (same as `aiui config tui`)
aiui config show         # every key: effective value + which file set it
aiui config show --json  # machine-readable: file paths, per-level values, effective merge
aiui config get chrome.mode            # the effective value (provenance on stderr)
aiui config set chrome.mode launch     # validated write to the user config
aiui config set chrome.headless true --project   # …or to .aiui-cache/config.json here
aiui config unset claude.skipPermissions         # remove a key (get re-asked on first run)
```

The **TUI** (bare `aiui config`, in a real terminal) lists every key grouped by section; the
panel under the list is the documentation card — what the key does, its default, and what the
user and project files each say. Picking a key offers set/unset at either level: enums and
booleans become menus, strings and numbers a validated input. `Ctrl-C` leaves at any point.

`set` and `unset` write the **user** file unless you pass `--project` — same reasoning as the
first-run prompts above: personal preferences belong to the user level, and the project file
(which a team may share or commit) is only touched deliberately. Values are validated before
writing, so you can't `set` a config that would then fail the launch.

## All keys

```json
{
  "claude": {
    "skipPermissions": true,
    "enterNudge": true
  },
  "channel": {
    "bind": "loopback"
  },
  "sidecars": {
    "code": true,
    "paint": true
  },
  "chrome": {
    "enabled": true,
    "mode": "attach",
    "browserUrl": "http://127.0.0.1:9222",
    "debugPort": 0,
    "profile": "default",
    "dataDir": "/absolute/path/to/user-data-dir",
    "executablePath": "/path/to/chrome-for-testing/chrome",
    "channel": "stable",
    "forTesting": "prompt",
    "headless": false,
    "buildExtension": true
  }
}
```

Everything is optional; the values above are the defaults (except `browserUrl`, `dataDir`,
`executablePath`, and `sidecars.code`, which default to unset). `claude.skipPermissions`,
`claude.enterNudge`, and `channel.bind` are asked on the first interactive launch and persisted.

| Key                     | Meaning                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `claude.skipPermissions` | Launch with `--dangerously-skip-permissions` — a [personal preference with real consequences](./warning); aiui works fine either way. Asked on the first interactive launch (no default — you must answer); unset non-interactive sessions fall back to `true`. |
| `claude.enterNudge`     | Auto-dismiss Claude Code's development-channel acknowledgement prompt by injecting one Enter keystroke into your terminal at startup (best-effort TIOCSTI; some platforms forbid it, harmlessly). Asked on the first interactive launch; saying no just means pressing Enter yourself each launch. |
| `channel.bind`          | Which interface the channel's web server binds. `"loopback"` (default) keeps the whole surface this-machine-only; `"host"` (0.0.0.0) makes it — the [iPad paint](./paint-stream) page, but also prompt injection, `/debug`, and every sidecar — reachable by **anyone on your network, unauthenticated** ([the trusted-LAN posture](./warning)). Asked on the first interactive launch, like `claude.skipPermissions`. Per-launch flag: `--aiui-bind`. |
| `sidecars.paint`        | Host the [iPad paint](./paint-stream) sidecar. On by default — it rides the channel's one port (no extra process or listener); whether an iPad can *reach* it is `channel.bind`'s call. `false` turns it off. Per-launch flags win: `--aiui-sidecar` / `--aiui-no-sidecar paint`. |
| `chrome.enabled`        | Attach the [Chrome DevTools MCP](./chrome). `false` turns it off everywhere; `true` restates the default and does **not** override the CI default-off — only the `--aiui-chrome` flag does. |
| `chrome.mode`           | [`"attach"`](./chrome#how-the-browser-connects-attach-vs-launch) (default): share a user-visible session browser. `"launch"`: chrome-devtools-mcp keeps a private browser, started lazily on the agent's first tool call. |
| `chrome.browserUrl`     | Attach to this DevTools endpoint (e.g. `"http://127.0.0.1:9222"`) and manage no browser locally — the [remote development](./remote) key (per-launch flag: `--aiui-browser-url`). Implies `mode: "attach"`; makes the other browser keys irrelevant. |
| `chrome.debugPort`      | Fixed debug port for session browsers aiui launches (default `0` = OS-assigned). Pin it when something external must find it — e.g. a [VS Code attach-to-Chrome launch config](./remote#bonus-breakpoints-via-vs-code) for local sessions. (Tunnels don't need it: `aiui browser --tunnel` fixes the *remote* port instead.) |
| `chrome.profile`        | Named profile under `.aiui-cache/chrome/` (flag: `--aiui-chrome-profile`).                                                                        |
| `chrome.dataDir`        | Explicit Chrome user data dir; beats `profile` (flag: `--aiui-chrome-data-dir`).                                                                  |
| `chrome.executablePath` | Chrome binary to launch — e.g. [Chrome for Testing](./chrome#chrome-for-testing-the-recommended-browser). Mutually exclusive with `channel`.      |
| `chrome.channel`        | Installed Chrome release channel to launch: `stable`, `beta`, `dev`, `canary`.                                                                    |
| `chrome.forTesting`     | How launches manage the recommended [Chrome for Testing](./chrome#the-managed-install): `"prompt"` (offer installs/updates — interactive sessions only, never CI), `"auto"` (keep current without asking), `"off"` (never check). Prompt answers ("automatically", "never ask again") are written **here, at the user level**, by the launcher itself. Skipped when `executablePath`/`channel` picks a browser explicitly. |
| `chrome.headless`       | Launch Chrome with no UI.                                                                                                                          |
| `chrome.buildExtension` | Rebuild the [aiui DevTools panel](./devtools) (~0.3 s of tsc) whenever a browser starts in a dev checkout, so the auto-loaded extension is never stale. |

## Environment variables

| Variable              | Effect                                                                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `AIUI_CACHE`          | Overrides the **user cache root** entirely. Everything user-level lives under it: the channel server registry (`<cache>/mcp/`), the user `config.json`, managed Chrome for Testing installs and their update bookkeeping (`<cache>/chrome/`). Tests and the e2e harness use this to sandbox a whole aiui world. |
| `XDG_CACHE_HOME`      | Standard cache-home: when set (and absolute), the user cache root is `$XDG_CACHE_HOME/aiui`; otherwise `~/.cache/aiui`. `AIUI_CACHE` beats it. |
| `CI`                  | Truthy values (anything but unset, empty, `"0"`, `"false"`) mean: Chrome DevTools MCP off by default, and **no interactive behavior at all** — no CfT install/update prompts or downloads, no one-time hints. `aiui claude --aiui-chrome` opts the MCP back in. |
| `OPENAI_API_KEY`      | The intent pipeline's speech transcription and dictation correction call OpenAI, from the channel process aiui spawns — so the key is read from **this environment** and nowhere else (never `config.json`; a shared/committed file must not hold secrets). `aiui claude` [preflights it](#the-intent-pipeline-openai-key) at launch; unset or invalid leaves those features **unavailable** (the widget says so; `mock` is the explicit offline choice), never blocking the launch. |
| `VITE_AIUI_PORT`      | **Written by aiui, not read**: `aiui vite` sets it to the chosen channel server's port. The `aiuiDevOverlay()` Vite plugin reads it in the dev-server process and injects it into the page for the [intent tool](./web-intent-tool); app source can also read it via `import.meta.env.VITE_AIUI_PORT` (the prebuilt overlay itself cannot — see the intent-tool page's internals note). |

(Repo CI additionally uses `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_MODEL`, and `IS_SANDBOX` when it
shells out to Claude Code itself — those configure Claude Code, not aiui; see
`.github/workflows/ci.yml`.)

## The intent pipeline (OpenAI key)

The [multimodal intent overlay](./web-intent-tool)'s speech transcription and dictation
correction run against OpenAI, in the **channel process** `aiui claude` spawns. That process
inherits the launcher's environment, so the key comes from `OPENAI_API_KEY` in the shell you run
`aiui claude` from — deliberately the *only* source. It is never read from `config.json` (a
project file is shareable and will eventually be committed — a key must not live there) and there
is no `aiui claude` flag for it.

**Preflight.** On an interactive launch (a real TTY, not CI — the same gate as the Chrome for
Testing prompts), `aiui claude` checks the key before handing off, so a missing or stale key is a
clear message up front rather than a confusing failure mid-session. It makes one cheap
authenticated call (`GET https://api.openai.com/v1/models`, read for HTTP status only, ~3 s
timeout) and reports one of four outcomes — **the key itself is never printed, logged, or sent
anywhere but OpenAI**:

| Status       | What it means                                                     | What you see |
| ------------ | ----------------------------------------------------------------- | ------------ |
| `valid`      | Present and accepted.                                              | Nothing — the launcher stays quiet. |
| `missing`    | `OPENAI_API_KEY` is not set.                                      | Where to set it, and that transcription/correction are unavailable until it is (the mock backends are the offline alternative). |
| `invalid`    | Present but rejected (401/403).                                   | The likely cause — a **stale shell export** shadowing your real key — and how to check: `echo $OPENAI_API_KEY \| head -c 12` against the start of your real key. |
| `unverified` | Present but not checked (CI/non-interactive) or the check couldn't complete (offline, timeout). | A note that it's unverified, not known-bad; launch continues. |

**Degradation, not refusal.** A bad or missing key never blocks the launch — the intent modality
still mounts, but transcription and correction are then **unavailable** until the key is set: the
widget says so rather than silently switching to the mock backends (those are the explicit offline
choice, `transcriber`/`corrector: "mock"`). The launcher only informs (the same posture as the
browser-side degradations). CI and other non-interactive sessions skip
the network check silently. Either way the outcome (a *status*, never the key) is recorded in the
channel's launch summary at `GET /debug/api/info`, so the [DevTools panel](./devtools) can
explain a degraded pipeline.

**Pipeline configuration lives in the overlay, not here.** Which transcription/correction models,
the corrector policy, silence gating, keyword priming — all of that is `IntentPipelineConfig`,
owned and configured by the overlay (`aiuiDevOverlay({ intent: { … } })` plus channel-side
config), not by `aiui claude` flags. This includes the transcriber choice — `transcriber: "openai"`
(REST, the default), the experimental `"openai-realtime"` (streaming — partial transcripts as you
speak, using the same channel key), `"openai-voice"` (the flagship conversational session — the
model talks back, though its input transcription still feeds the prompt), or `"mock"` (offline).
The easy way to pick a rung is the `tier` field — a cost-sized preset over these fields, from
`mock` (offline) up to `flagship` (spoken answers); see the overlay guide's
[Tiers](./intent-overlay#tiers-one-dial-for-the-whole-ladder). The launcher's whole job is
preflighting this key and passing the environment through. The
[Using the intent overlay](./intent-overlay) guide page covers those knobs.

## State aiui keeps (and how it affects behavior)

Not configuration you edit, but worth knowing when behavior seems sticky:

| File                                            | Purpose                                                                                             |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `<user cache>/chrome/update-state.json`          | CfT prompt bookkeeping: when the latest-stable version was last checked (≤ once/day), which update you chose to skip, when an install offer was declined (snoozed a day). Delete it to be re-asked. |
| `<profile>/DevToolsActivePort`                   | Written by Chrome itself; how aiui discovers a running [session browser](./chrome).                   |
| `<profile>/aiui-browser.json`                    | Informational breadcrumb (pid, start time) for the session browser aiui launched.                     |
| `<profile>/aiui-devtools-hint`                   | Marker that the one-time "the panel can't auto-load into branded Chrome" note was shown for this profile. |

## Strict on purpose

A malformed `config.json`, an unknown key, or a wrong value type **fails the launch** with an
error naming the file — no warn-and-continue. These settings gate security-relevant behavior
(`skipPermissions`), and a typo that silently falls back to the dangerous default would be worse
than a failed start.
