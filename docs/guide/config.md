# Configuration

Everything that shapes aiui's behavior, in one place: the one `config.json`, the CLI flags that
override it, the environment variables, and the bits of on-disk state that drive prompting.

## How it works

There is **one flat, user-level config file**: `~/.cache/aiui/config.json` (respecting
`AIUI_CACHE` and `XDG_CACHE_HOME`). The former project-level layer (`.aiui-cache/config.json`)
and its per-key merge are retired — the browser-profiles redesign moved browser *identity* into
[profile markers](#where-browser-identity-went-profiles), and what remains in config are
per-user machine facts. Settings resolve through a short ladder — the first level that speaks,
wins:

1. **CLI flags** ([`--aiui-*`](#per-launch-flags-aiui-) on `aiui claude` and friends) — one
   launch only.
2. **User config** — `config.json` at the user cache root.
3. **Built-in defaults.**

Two asymmetries to know about:

- **CI wins for the browser**: under a truthy `CI` env var the shared session browser (and the
  Chrome DevTools MCP that drives it) defaults off — only an explicit `--aiui-session-browser`
  brings it up there.
- **aiui writes the config too**: `aiui config yolo` (below), managed-browser prompt answers
  ("automatically", "never ask again" → `chrome.manage`), and the per-provider key decisions
  from the first-launch interview (`keys.*`) are all persisted by the CLI itself.

## Checking and editing: `aiui config`

You never have to open the file by hand — every key is browsable and editable from the CLI,
rendered from the same schema the loader validates against (so what the commands show is exactly
what a launch would accept):

```sh
aiui config              # the interactive browser (same as `aiui config tui`)
aiui config show         # every key: effective value + docs, defaults included
aiui config show --json  # machine-readable
aiui config get channel.bind           # the effective value (provenance on stderr)
aiui config set chrome.manage auto     # validated write
aiui config unset claude.args          # back to the default
aiui config yolo                       # the double opt-in — see below
```

The **TUI** (bare `aiui config`, in a real terminal) lists every key grouped by section; the
panel under the list is the documentation card — what the key does, its default, and what the
config file says. Enums and booleans become menus, strings and numbers a validated input.
Values are validated before writing, so you can't `set` a config that would then fail the
launch.

**`aiui config yolo`** is the one explicit opt-in to the trusting posture, and it flips two
things at once after a stated-consequences confirmation: it appends
`--dangerously-skip-permissions` to `claude.args` (idempotently) AND sets
`channel.bind: "host"`. Nothing else sets either — there is no first-run question for them,
deliberately ([why](./warning)). Undo with `aiui config unset claude.args` and
`aiui config unset channel.bind`.

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
    "manage": "prompt",
    "headless": false
  },
  "keys": {
    "openai": "vault",
    "gemini": "skip",
    "elevenlabs": "vault"
  }
}
```

Everything is optional; the values above show the defaults where one exists (`claude.args` and
the `keys.*` decisions default to unset).

| Key                     | Meaning                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `claude.args`           | Extra argv passed verbatim to `claude` on **every** launch, ahead of any per-launch passthrough. This is where `--dangerously-skip-permissions` lives — added by `aiui config yolo`, a [personal preference with real consequences](./warning) that is **opt-in and never added by default**. Set the whole list with `aiui config set claude.args '["--foo"]'` (JSON); clear it with `aiui config unset claude.args`. |
| `claude.enterNudge`     | Auto-dismiss Claude Code's development-channel acknowledgement prompt by injecting one Enter keystroke into your terminal at startup (best-effort TIOCSTI; some platforms forbid it, harmlessly). **Currently inert**: the nudge mechanism is disabled behind a master switch (`util/enter-nudge.ts`); the setting is kept for its return, and while it's off nothing asks for it either. |
| `channel.bind`          | Which interface the channel's web server binds. `"loopback"` (default) keeps the whole surface this-machine-only; `"host"` (0.0.0.0) makes it — the remote-device sidecar pages, but also prompt injection, the debug API, and everything else — reachable by **anyone on your network, unauthenticated** ([the trusted-LAN posture](./warning)). Deliberately **never a first-run question**: the only opt-in is the explicit, warned `aiui config yolo`. Per-launch flag: `--aiui-bind`. |
| `chrome.manage`         | How launches keep the **managed browser binaries** installed/current: `"prompt"` (offer installs/updates — interactive sessions only, never CI), `"auto"` (keep current without asking), `"off"` (never check). Prompt answers persist here, written by the launcher itself. Skipped when the profile's marker names a branded channel or an explicit binary. |
| `chrome.headless`       | Launch Chrome with no UI.                                                                                                                          |
| `keys.openai` / `keys.gemini` / `keys.elevenlabs` | The per-provider vendor-key **decision**: `"vault"` (in use — the secret rests in the OS vault, never in this file) or `"skip"` (deliberately unused; nothing asks again). Unset means "never interviewed" — the next interactive `aiui claude` asks once. Managed by [`aiui keys`](#vendor-api-keys-openai--gemini--elevenlabs); `aiui config set` works too but doesn't touch the vault. |

**Retired keys are tolerated, then dropped** — never a hard error on upgrade: the whole
browser-identity batch (`chrome.enabled`, `mode`, `browserUrl`, `debugPort`, `profile`,
`dataDir`, `executablePath`, `channel`, `managed`, `forTesting`, plus the older
`buildExtension`/`autoCapture`) moved into profile markers or became flag-only with the
browser-profiles redesign; `claude.skipPermissions` retired into `claude.args`; the `sidecars`
section is gone entirely. A genuinely unknown key (a typo) still
[fails the launch](#strict-on-purpose).

## Where browser identity went (profiles)

*Which* browser to run is no longer config — it belongs to the **profile**, a named user data
dir under `~/.cache/aiui/userdata/<name>/` whose immutable `aiui-profile.json` marker records
the browser it was created for (managed Chromium — the default — or Chrome for Testing, a
branded release channel, or an explicit executable):

```sh
aiui profile list                 # every profile + what its marker names
aiui profile new lab --cft        # a profile on the other managed flavor
aiui profile rm lab
aiui profile adopt old-profile    # stamp a marker onto a pre-existing data dir
```

`chrome.manage` governs only whether the managed **binaries** get installed/updated;
`aiui chrome status` shows both halves (per-flavor installs + the default profile). The full
story is [the chrome guide](/packages/aiui/chrome).

## Per-launch flags (`--aiui-*`)

aiui's own flags all start with `--aiui-` so they can't collide with flags meant for the
wrapped command (`claude --resume`, …); everything else passes through. An unknown `--aiui-*`
flag throws rather than leaking into the child command.

| Flag | Effect |
| ---- | ------ |
| `--aiui-bind <loopback\|host>` | Where the channel's web backend binds, this launch only. |
| `--aiui-session-browser` / `--aiui-no-session-browser` | Force the shared session browser + its Chrome DevTools MCP on (even under CI) / launch without either. |
| `--aiui-browser` / `--aiui-no-browser` | Force opening the wrapped tool's page in the session browser (CI/headless) / never open one. |
| `--aiui-profile <name>` | Launch with the named browser profile (created on first use). |
| `--aiui-chrome-data-dir <path>` | An explicit Chrome user data dir instead of a named profile. |
| `--aiui-browser-url <url>` | Attach the Chrome DevTools MCP to this endpoint (e.g. a tunneled [remote browser](/packages/aiui/remote)) and manage no browser locally. |
| `--aiui-tag <tag>` | The channel/MCP session tag (usable with `aiui mcp quick --tag`). |

## Environment variables

| Variable              | Effect                                                                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `AIUI_CACHE`          | Overrides the **user cache root** entirely. Everything user-level lives under it: the channel registry (`<cache>/mcp/`), `config.json`, managed browser installs (`<cache>/chromium/`, `<cache>/chrome/`), profiles (`<cache>/userdata/`), and the per-project caches (`<cache>/projects/<slug>-<hash8>/` — traces, logs, recordings). Tests and the e2e harness use this to sandbox a whole aiui world. |
| `XDG_CACHE_HOME`      | Standard cache-home: when set (and absolute), the user cache root is `$XDG_CACHE_HOME/aiui`; otherwise `~/.cache/aiui`. `AIUI_CACHE` beats it. |
| `CI`                  | Truthy values (anything but unset, empty, `"0"`, `"false"`) mean: session browser off by default, and **no interactive behavior at all** — no install/update prompts or downloads, no first-run questions. `--aiui-session-browser` opts the browser back in. |
| `OPENAI_API_KEY` / `GEMINI_API_KEY` / `ELEVEN_LABS_API_KEY` | The three vendor keys the channel can use — honored from the environment **only when aiui runs from a source checkout** (where `.env`/direnv are the dev workflow, and the environment wins over everything). An **installed** aiui ignores these entirely and reads the [OS vault](#vendor-api-keys-openai--gemini--elevenlabs) instead — a stray shell export can't silently override the vault, and keys stay out of the agent's environment. Never read from `config.json` in either mode. |
| `AIUI_NO_SOURCE_MODE` | Force the **installed** key-resolution mode (vault-only, environment ignored) even from a source checkout — how the installed posture is exercised without installing. |
| `VITE_AIUI_PORT`      | **The standalone intent panel's build-time channel port.** The intent client's own dev launcher (`scripts/dev.ts` in that package, or a manual `VITE_AIUI_PORT=… pnpm dev`) sets it so the panel — served on Vite's own origin during development — knows which channel to drive; read via `import.meta.env.VITE_AIUI_PORT`. When the channel itself serves the panel at `/intent/`, it is unset and the panel uses its own origin. (Prebuilt dist code cannot read it — the substitution happens when a bundler compiles the file.) |

(Repo CI additionally uses `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_MODEL`, and `IS_SANDBOX` when it
shells out to Claude Code itself — those configure Claude Code, not aiui; see
`.github/workflows/ci.yml`.)

## Vendor API keys (OpenAI · Gemini · ElevenLabs)

The intent pipeline's model-backed features (transcription, correction, the linter) run in the
**channel process** `aiui claude` spawns, against three vendors. Where their keys come from
depends on how aiui itself is running:

- **Source checkout (dev):** the environment wins — `.env`/direnv keep working exactly as
  before. A key absent from the environment falls back to the OS vault.
- **Installed:** the environment is ignored for keys. The **OS vault** — the macOS login
  keychain, or the freedesktop Secret Service on Linux — is the only store, and the channel
  reads it in its own process at boot, so vendor keys never travel through the agent's
  environment (where a shell `env` would print them).

What the vault holds is the secret; what `config.json` holds is the per-provider **decision**
(`keys.openai` etc.): `"vault"` (in use) or `"skip"` (deliberately unused). A provider with no
decision gets **one question** at the next interactive `aiui claude` — and the question is just a
prompt to paste into: **paste the key and press Enter to store it (straight into the vault), or
press Enter alone to skip.** What you paste echoes as `*` per character, so you can see that it
landed and roughly how long it is without the secret ever appearing on screen. **In a source
checkout, a provider whose key is already in the environment is used silently — no question, and
nothing is written to the vault.** The launch never migrates an env key into the vault or records
a decision on your behalf; that is deliberately an explicit act (`aiui keys set <provider>`). The
`aiui keys` command manages all of it:

```sh
aiui keys status            # mode + per-provider decision + effective source — never values
aiui keys interview         # all providers: keep the stored key, replace it, or skip
aiui keys set openai        # store one key (paste prompt, echoed as *; or pipe it on stdin)
aiui keys unset openai      # remove the vault entry and mark the provider skipped
```

Every store is verified by an immediate read-back — both platform CLIs' observed failure modes
were *silent* corruption. Secrets never appear in argv, shell history, logs, or the config file.

**Preflight.** On an interactive launch (a real TTY, not CI), `aiui claude` checks every
**resolved** key (env or vault, per the mode above) against its vendor's cheapest authenticated
endpoint — OpenAI `GET /v1/models`, Gemini's model list, ElevenLabs `GET /v1/user` — read for
status only; **the keys are never printed, logged, or sent anywhere but their own vendor**. A
*skipped* provider is a chosen absence and gets no note at all. Outcomes:

| Status       | What it means                                                     | What happens |
| ------------ | ----------------------------------------------------------------- | ------------ |
| `valid`      | Present and accepted.                                              | Nothing — the launcher stays quiet. |
| `missing`    | No key resolved for the provider.                                  | A degradation warning naming exactly what's parked — no OpenAI key: transcription/dictation-correction unavailable; no ElevenLabs key: the default Scribe transcriber unavailable (falls back to the OpenAI realtime engine); no Gemini key: only the opt-in realtime tier parked. The launch continues. |
| `invalid`    | Present but definitively rejected (401/403).                       | **The launch aborts** with the remedy (`aiui keys set <provider>` replaces a stale vault entry; in dev, fix the shell export). A rejected key would fail confusingly mid-session — better to stop at the door. |
| `unverified` | Present but not checked (CI/non-interactive, offline, timeout).    | A quiet note; launch continues. |

Either way each outcome (a *status*, never the key) is recorded in the channel's launch summary
at `GET /debug/api/info` (`launch.openaiKey` / `launch.geminiKey` / `launch.elevenlabsKey`), so
a viewer can explain a degraded pipeline.

**Pipeline configuration lives in the intent client, not here.** Which transcription engine
(Scribe v2 is the default), the [prompt linter](./intent-panel#the-prompt-linter), silence
gating, keyword priming — all of that is `IntentPipelineConfig`, owned and declared by the
client on every hello, not by `aiui claude` flags. The launcher's whole job is the gap-fill
question and the preflight — the channel resolves its own keys at boot. See
[The Intent Panel](./intent-panel) for the engines and their knobs.

## State aiui keeps (and how it affects behavior)

Not configuration you edit, but worth knowing when behavior seems sticky:

| File                                            | Purpose                                                                                             |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `<user cache>/<flavor>/update-state.json`        | Managed-browser prompt bookkeeping (one per flavor — `chromium/`, `chrome/`): when latest-stable was last checked (≤ once/day), which update you chose to skip, when an install offer was declined. Delete it to be re-asked. |
| `<user cache>/userdata/<name>/aiui-profile.json` | The **profile marker** — which browser this profile launches. Immutable; `aiui profile` manages it.   |
| `<profile>/DevToolsActivePort`                   | Written by Chrome itself; how aiui discovers a running [session browser](/packages/aiui/chrome).      |
| `<profile>/aiui-browser.json`                    | Informational breadcrumb (pid, start time) for the session browser aiui launched.                     |

## Strict on purpose

A malformed `config.json`, an unknown key, or a wrong value type **fails the launch** with an
error naming the file — no warn-and-continue. These settings gate security-relevant behavior
(`claude.args`, e.g. whether `--dangerously-skip-permissions` is passed), and a typo that
silently drops such a flag would be worse than a failed start. (Keys retired in an upgrade —
the [tolerated-and-dropped list above](#all-keys) — are the one exception: they're accepted
and ignored, never a hard error.)
