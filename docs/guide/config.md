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
still inherits your user-level `chrome.manage`). Put personal defaults (your `chrome.managed`
browser preference, `claude.args`) at the user level and project specifics (a dedicated
profile, headless, a remote `browserUrl`) in the project file.

Two asymmetries to know about:

- **CI wins over config for the browser**: under a truthy `CI` env var the Chrome DevTools MCP
  defaults off regardless of `chrome.enabled` — only an explicit `--aiui-chrome` flag brings it
  up there.
- **aiui writes the user config too**: the **first interactive launch asks** for the settings
  that deserve a deliberate answer — auto-dismiss the channel prompt? bind the channel to your
  LAN? — and persists them as `claude.enterNudge` / `channel.bind`; managed-browser prompt
  answers ("automatically", "never ask again") persist as `chrome.manage` the same way.
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
aiui config set-dsp                     # add --dangerously-skip-permissions to claude.args
aiui config unset claude.args           # drop the extra-args list (undoes set-dsp)
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
    "args": ["--dangerously-skip-permissions"],
    "enterNudge": true
  },
  "channel": {
    "bind": "loopback"
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
    "managed": "chromium",
    "manage": "prompt",
    "headless": false
  }
}
```

Everything is optional; the values above are the defaults (except `claude.args`, `browserUrl`,
`dataDir`, and `executablePath`, which default to unset). `claude.enterNudge` and `channel.bind`
are asked on the first interactive launch and persisted.

| Key                     | Meaning                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `claude.args`           | Extra argv passed verbatim to `claude` on **every** launch, ahead of any per-launch passthrough. This is where `--dangerously-skip-permissions` lives — add it with `aiui config set-dsp`, a [personal preference with real consequences](./warning) that is **opt-in and never added by default**. Set the whole list with `aiui config set claude.args '["--foo"]'` (JSON); clear it with `aiui config unset claude.args`. |
| `claude.enterNudge`     | Auto-dismiss Claude Code's development-channel acknowledgement prompt by injecting one Enter keystroke into your terminal at startup (best-effort TIOCSTI; some platforms forbid it, harmlessly). Asked on the first interactive launch; saying no just means pressing Enter yourself each launch. |
| `channel.bind`          | Which interface the channel's web server binds. `"loopback"` (default) keeps the whole surface this-machine-only; `"host"` (0.0.0.0) makes it — the remote-device sidecar pages, but also prompt injection, `/debug`, and everything else — reachable by **anyone on your network, unauthenticated** ([the trusted-LAN posture](./warning)). Asked on the first interactive launch. Per-launch flag: `--aiui-bind`. |
| `chrome.enabled`        | Attach the [Chrome DevTools MCP](./chrome). `false` turns it off everywhere; `true` restates the default and does **not** override the CI default-off — only the `--aiui-chrome` flag does. |
| `chrome.mode`           | [`"attach"`](./chrome#how-the-browser-connects-attach-vs-launch) (default): share a user-visible session browser. `"launch"`: chrome-devtools-mcp keeps a private browser, started lazily on the agent's first tool call. |
| `chrome.browserUrl`     | Attach to this DevTools endpoint (e.g. `"http://127.0.0.1:9222"`) and manage no browser locally — the [remote development](./remote) key (per-launch flag: `--aiui-browser-url`). Implies `mode: "attach"`; makes the other browser keys irrelevant. |
| `chrome.debugPort`      | Fixed debug port for session browsers aiui launches (default `0` = OS-assigned). Pin it when something external must find it — e.g. a [VS Code attach-to-Chrome launch config](./remote#bonus-breakpoints-via-vs-code) for local sessions. (Tunnels don't need it: `aiui browser --tunnel` fixes the *remote* port instead.) |
| `chrome.profile`        | Named profile under `.aiui-cache/chrome/<variant>/` (flag: `--aiui-chrome-profile`). Profiles are partitioned by browser variant.                 |
| `chrome.dataDir`        | Explicit Chrome user data dir; beats `profile` (flag: `--aiui-chrome-data-dir`).                                                                  |
| `chrome.executablePath` | Explicit browser binary to launch — e.g. a [Chrome for Testing](./chrome#the-managed-browser-chromium-default-or-chrome-for-testing) you manage yourself. Overrides `chrome.managed`. Mutually exclusive with `channel`. |
| `chrome.channel`        | Installed Chrome release channel to launch: `stable`, `beta`, `dev`, `canary`. Overrides `chrome.managed`.                                        |
| `chrome.managed`        | Which browser aiui downloads and manages: [`"chromium"`](./chrome#the-managed-browser-chromium-default-or-chrome-for-testing) (default — dodges the CfT reCAPTCHA fingerprint) or `"chrome-for-testing"`. Each flavor keeps its own install and its own project profiles. Ignored when `executablePath`/`channel` picks a browser explicitly. |
| `chrome.manage`         | How launches keep the managed browser installed/current: `"prompt"` (offer installs/updates — interactive sessions only, never CI), `"auto"` (keep current without asking), `"off"` (never check). Prompt answers ("automatically", "never ask again") are written **here, at the user level**, by the launcher itself. Skipped when `executablePath`/`channel` picks a browser explicitly. *(The old name `chrome.forTesting` still works as a deprecated alias when `chrome.manage` is unset.)* |
| `chrome.headless`       | Launch Chrome with no UI.                                                                                                                          |

## Environment variables

| Variable              | Effect                                                                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `AIUI_CACHE`          | Overrides the **user cache root** entirely. Everything user-level lives under it: the channel server registry (`<cache>/mcp/`), the user `config.json`, managed browser installs and their update bookkeeping (`<cache>/chromium/`, `<cache>/chrome/`). Tests and the e2e harness use this to sandbox a whole aiui world. |
| `XDG_CACHE_HOME`      | Standard cache-home: when set (and absolute), the user cache root is `$XDG_CACHE_HOME/aiui`; otherwise `~/.cache/aiui`. `AIUI_CACHE` beats it. |
| `CI`                  | Truthy values (anything but unset, empty, `"0"`, `"false"`) mean: Chrome DevTools MCP off by default, and **no interactive behavior at all** — no CfT install/update prompts or downloads, no one-time hints. `aiui claude --aiui-chrome` opts the MCP back in. |
| `OPENAI_API_KEY`      | The intent pipeline's speech transcription and dictation correction call OpenAI, from the channel process aiui spawns — so the key is read from **this environment** and nowhere else (never `config.json`; a shared/committed file must not hold secrets). `aiui claude` [preflights it](#the-intent-pipeline-openai-key) at launch; unset or invalid leaves those features **unavailable** (the widget says so; `mock` is the explicit offline choice), never blocking the launch. |
| `VITE_AIUI_PORT`      | **The standalone intent panel's build-time channel port.** The intent client's own `pnpm dev` launcher (or a manual `VITE_AIUI_PORT=… pnpm dev`) sets it so the plain-page panel — served on Vite's own origin, not the channel's — knows which channel to drive; it is read via `import.meta.env.VITE_AIUI_PORT`. Apps served by `aiui vite` do **not** use it: they reach the channel through the intent client at `/intent/`. (Prebuilt dist code cannot read it — the substitution happens when a bundler compiles the file.) |

(Repo CI additionally uses `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_MODEL`, and `IS_SANDBOX` when it
shells out to Claude Code itself — those configure Claude Code, not aiui; see
`.github/workflows/ci.yml`.)

## The intent pipeline (OpenAI key)

The intent pipeline's speech transcription and dictation
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
still mounts, but transcription (and the linter, if enabled) are then **unavailable** until the
key is set: the widget says so rather than silently switching to the mock backend (that is the
explicit offline choice, `transcriber: "mock"`). The launcher only informs (the same posture as the
browser-side degradations). CI and other non-interactive sessions skip
the network check silently. Either way the outcome (a *status*, never the key) is recorded in the
channel's launch summary at `GET /debug/api/info`, so a viewer can explain a degraded
pipeline.

**Pipeline configuration lives in the intent client, not here.** Which transcription models, the
[prompt linter](./prompt-linting), silence gating, keyword priming — all of that is
`IntentPipelineConfig`, owned and declared by the client on every hello, not by `aiui claude`
flags.
Transcription is streaming (`transcriber: "openai-realtime"` — partial transcripts as you
speak, using the same channel key; `"mock"` is the offline choice). The easy way to pick a
rung is the `tier` field — `rapid` (the default) or `premium`. The linter is orthogonal
(`linter: "off" | "openai" | "gemini"`; a Gemini linter needs `GEMINI_API_KEY` in the same
environment). The launcher's whole job is preflighting the OpenAI key and passing the
environment through.

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
(`claude.args`, e.g. whether `--dangerously-skip-permissions` is passed), and a typo that
silently drops such a flag would be worse than a failed start. (Keys retired in an upgrade — like
the old `claude.skipPermissions` boolean — are the one exception: they're tolerated and ignored,
never a hard error.)
