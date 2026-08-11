# The Agent's Browser

`aiui claude` attaches Google's
[Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) to the session by
default, so the agent can drive a real Chrome: navigate, click, fill forms, screenshot, read the
console, evaluate JavaScript. See
[⚠️ Read before running](/guide/warning#_3-the-agent-gets-a-browser-by-default) for what that implies
before deciding it's on.

The design goal is one **session browser**: a single, user-visible Chrome that you and the agent
share — you click around in the same tabs the agent drives, the agent screenshots the page you're
looking at, and the [intent client's extension](/guide/intent-panel) is loaded in it. That's what
makes deictic work ("make *this* wider") possible.

Sharing a browser needs manners, so whenever the Chrome DevTools MCP is attached, `aiui claude`
also loads the **session-browser skill** from the bundled
[plugin marketplace](/packages/aiui-claude-plugin/) — etiquette (announce visible actions,
open your own tabs, never resize) plus the page-tools surface and tab-routing mechanics.
Sessions without the browser skip the skill entirely.

## On and off

| Situation                                          | Result                                     |
| -------------------------------------------------- | ------------------------------------------ |
| Default                                            | Attached                                   |
| `CI` set in the environment                        | Off (`--aiui-session-browser` forces it back on) |
| `--aiui-no-session-browser`                        | Off, beats everything                      |

One flag governs both halves — the browser exists so the MCP has something to drive, so
"off" means no browser is launched AND no MCP is attached. (The old `chrome.enabled` /
`chrome.mode` config keys are retired; this is flag-only now.)

## How the browser connects: attach vs launch

chrome-devtools-mcp can either *launch* its own browser or *attach* to a running one's DevTools
debug endpoint. aiui defaults to **attach**, because a browser the MCP launches privately is
invisible until the agent first touches it and is never the window you're working in. The decision
ladder at `aiui claude` time:

1. **`--aiui-browser-url <url>` passed** → attach to that endpoint verbatim. The browser is
   managed elsewhere — usually on your local machine while the session runs remotely (this is
   the invocation [`aiui remote`](./remote) prints). Nothing browser-related happens on the
   session's machine.
2. **A session browser is already running on this profile** → attach to it. Discovery is
   Chrome-native: an instance started with a debug port writes `DevToolsActivePort` into its user
   data dir; aiui reads it and probes the endpoint. (Attaching also refreshes the profile's
   native-messaging manifest so the intent client's channel discovery stays current.)
3. **Interactive launch, nothing running** → aiui starts the session browser now — visible from
   the first moment, on the chosen profile, with the intent client's extension loaded — and
   attaches. The browser is deliberately independent of the Claude process: it's your window
   too, and it survives the session (and serves the next one, via rule 2). If the start fails,
   warn and fall through.
4. **Otherwise** — a non-interactive session (`-p`, no TTY) with nothing running, or a failed
   start — classic **launch mode**: chrome-devtools-mcp starts its own private browser lazily,
   on the agent's first browser tool call, with the profile's settings. This is what headless
   one-shots get automatically. (Don't mix modes on one profile: a launch-mode session can't
   start Chrome on a profile a session browser already holds.)

## Profiles pick the browser

**The profile is the unit of browser identity.** A profile is a Chrome user data dir under the
**user cache** — `~/.cache/aiui/userdata/<name>/` — carrying an immutable `aiui-profile.json`
marker that names its browser: a managed flavor (Chromium — the default — or Chrome for
Testing), a branded Chrome release channel, or an explicit executable. Launches specify only a
profile; the browser follows — nothing else gets to pick a binary. (The old
`chrome.managed`/`executablePath`/`channel`/`profile`/`dataDir` config keys are all retired
into the marker.)

```sh
aiui profile list                 # every profile + what its marker names
aiui profile new lab --cft        # a new profile on Chrome for Testing
aiui profile new blink --channel canary   # …or a branded channel
aiui profile rm lab
aiui profile adopt old-dir        # stamp a marker onto a pre-existing data dir
```

The profile named **`default` is shared across projects** — concurrent `aiui claude` runs in
different projects co-drive one browser window (`aiui remote` included; Chrome allows only one
instance per user data dir anyway). Isolation, when wanted, is a *named* profile
(`--aiui-profile lab`), not a per-project mechanism. Because a Chrome user data dir is
version- and build-sensitive, the marker is written at creation and never changed — "switch
this profile's browser" is answered with "create a new profile", so two builds never share
state.

Per-launch flags: `--aiui-profile <name>` (created on first use), and
`--aiui-chrome-data-dir <path>` (an explicit dir, escaping the convention). Whatever you log
into *inside* a profile's browser stays in the profile and is reachable by the agent in later
sessions.

## The managed browser: Chromium (default) or Chrome for Testing

Whenever aiui launches a browser (rules 3 and 4), the binary it recommends — and manages — is a
version-pinned **Chromium-family** build that aiui downloads and keeps current for you. Two
flavors exist; a profile's marker picks one (Chromium unless you say `--cft`):

- **`chromium`** (the default) — the open-source Chromium build.
- **`chrome-for-testing`** — Google's branded automation build of Chrome (CfT).

Both are the same engine as branded Chrome, with the operational properties an agent-driven
browser wants: **no auto-update** (a pinned, reproducible browser — not whatever stable updated
itself to overnight), **no first-run friction** (no default-browser prompts or sign-in promos),
and — critically — **`--load-extension` still works** (branded Chrome ≥ 137 ignores it), so the
intent client's extension loads automatically.

**Why Chromium is the default.** Chrome for Testing carries an automation fingerprint that Google
recognizes: as soon as you use Google Search (or other Google properties) inside it, you tend to
get a *"verify you're human"* reCAPTCHA — annoying in a browser you actually drive around. The
open-source Chromium build doesn't wear that fingerprint, so it behaves like an ordinary browser
for everyday navigation. CfT also bakes in an unremovable *"… is only for automated testing"*
infobar ([puppeteer#10516]); Chromium has none.

**What Chromium gives up** (pick a `--cft` profile if you need these): Widevine **DRM** and
some proprietary **codecs** (so some streaming video / protected media won't play), and Google
**account sign-in / profile sync**. For scientific-visualization work these rarely matter; if
they do for you, create a profile on the other flavor (`aiui profile new media --cft`) and
launch with `--aiui-profile media`. The two flavors keep **separate** installs, and every
profile is bound to one browser, so switching never mixes state.

[puppeteer#10516]: https://github.com/puppeteer/puppeteer/issues/10516

### Media prompts are pre-answered

The session browser launches with `--auto-accept-camera-and-microphone-capture` and
`--auto-accept-this-tab-capture`: microphone/camera permission prompts auto-accept (the *real*
default devices — no fakes), and current-tab capture
(`getDisplayMedia({ preferCurrentTab: true })` — what the shot tool's video share uses) skips
the share picker — tab capture needs no macOS Screen Recording grant. Without these, dictation
re-prompts per **origin** — every dev-server port is a distinct origin — and Chrome never
persists screen-share consent at all. `--autoplay-policy=no-user-gesture-required` rides along
so server-pushed speech plays without a click. (Not the older `--use-fake-ui-for-media-stream`:
that flag also hijacks the `getDisplayMedia` picker and auto-selects the *entire screen*, which
fails with `NotReadableError` when the managed binary lacks the macOS Screen Recording
permission.) This is a deliberate posture choice for a dev browser that already runs an
unauthenticated debug port (see [the warning](/guide/warning)): treat every page you open in it
as able to hear the mic and see the tab without asking.

### The managed install

Unless the profile's marker names a branded channel or an explicit binary, every
**interactive** launch that needs a browser syncs the managed browser (the marker's flavor) —
never in CI, never without a TTY, never in `-p`/`--print` mode; those sessions just use
whatever is already installed:

- **Not installed** → you're offered a download (yes / not now / never). "Not now" snoozes the
  offer for a day and that launch uses your regular Chrome; "never" writes `chrome.manage: "off"`
  to your user config.
- **Installed but stale** (checked against the latest build at most once per day, short network
  timeout, silently skipped offline) → *"Your Chromium is out of date. Update?"*
  - **yes, just this once** — update now, ask again next time.
  - **automatically** — update now and write `chrome.manage: "auto"`: from then on it stays
    current without asking.
  - **skip** — keep the current version and don't ask again *for this version*.
  - **never ask again** — writes `chrome.manage: "off"`.
- **Installed and current** → it's simply used. This also holds with `manage: "off"` — "off"
  silences checks and prompts, it doesn't un-prefer an install you made deliberately.

The knob is `chrome.manage` in [config.json](/guide/config): `"prompt"` (default) / `"auto"` / `"off"`.
(The old name `chrome.forTesting` still works as a deprecated alias when `chrome.manage` is
unset.)

## The commands

```sh
aiui open <url>         # open a URL as a tab in the session browser (starts one if needed)
aiui chrome install     # install (or bring to latest) the managed browser
aiui chrome install cft # …or target a specific flavor explicitly
aiui chrome update      # same as install, by its other name
aiui chrome status      # installs, profiles, what would launch/attach from here, and why
aiui profile list       # the profiles and what each one's marker names
aiui remote <host>      # the remote-development local half — see the remote guide
```

`aiui open http://localhost:5173` is the answer to "the Vite link opens my *default* browser":
open the app as a tab in the session browser instead, so you and the agent are looking at the
same page — starting the session browser first if none is running (the same shared pipeline
`aiui claude` and `aiui remote` use: profile marker, managed-browser sync, intent extension,
native-messaging manifest).

`aiui chrome status` is the diagnostic to reach for first: the managed-browser installs (both
flavors) and their freshness, the default profile and which browser its marker names, whether a
session browser is already running (and its endpoint), and whether the intent client will
auto-load. For a *running* session, the console (`aiui dashboard`) shows the same wiring **as
the session actually saw it at launch** — `aiui claude` hands the channel server a launch
summary (`--launch-info`), surfaced at `/debug/api/info`.

One aside on `--help`/`--version`: they're inert on the wrapper commands. `aiui claude --help`
prints aiui's own flag summary and then claude's help (two outputs, back to back) without
touching config, the browser, or the managed installs.

## Where everything lives

| What                                   | Where                                                                   |
| -------------------------------------- | ----------------------------------------------------------------------- |
| Chrome **user data dirs** (profiles)   | `~/.cache/aiui/userdata/<name>/` — user-level, shared across projects; the immutable `aiui-profile.json` marker names the profile's browser |
| The session browser's **debug port**   | `DevToolsActivePort` inside the profile dir — written by Chrome itself; aiui's discovery reads it (plus an informational `aiui-browser.json` breadcrumb) |
| Managed **browser** builds             | `~/.cache/aiui/chromium/` and `~/.cache/aiui/chrome/` (one per flavor) — user-level (respects `AIUI_CACHE`/`XDG_CACHE_HOME`), shared across projects, each with its own `update-state.json` bookkeeping |
| [Config](/guide/config)                     | `~/.cache/aiui/config.json` — the one config file |
| chrome-devtools-mcp's own default      | `~/.cache/chrome-devtools-mcp/chrome-profile` — only if you run it *without* aiui; aiui always pins the profile |

Because profiles persist, browser state accumulates usefully across sessions: logins, DevTools
settings, manually installed extensions — never touching your personal browser profile.

## The intent client's extension rides along

The intent client's MV3 bundle (`packages/aiui-intent-client/dist-ext`, a static build:
`pnpm -C packages/aiui-intent-client build:ext`) is auto-loaded via `--load-extension` whenever
aiui starts the session browser. Whether it *loads* depends on the browser:

- **The managed browser (Chromium or Chrome for Testing)** — auto-loads. This is the main reason
  a managed build is the recommended browser.
- **Branded Chrome (a `channel` profile)** — ≥ 137 ignores `--load-extension`
  (the flag was removed because malware abused it), so auto-load is a no-op. The fix is
  manual-but-once: in the session browser, `chrome://extensions` → Developer mode → Load
  unpacked → `packages/aiui-intent-client/dist-ext`. The persistent profile remembers it for
  every later session. Interactive launches print a one-time note per profile reminding you of
  exactly this (then a marker in the profile keeps it quiet).

aiui never builds the bundle at launch — building from the launcher would be a surprise write
into someone else's dev loop. `pnpm -C packages/aiui-intent-client ext` builds it and loads it
into the running session browser in one step. (`aiui claude` refuses to launch on a *corrupt*
bundle; the other session-browser starters — `aiui open`, `aiui remote` — warn and continue
without the extension.)

The extension's channel discovery runs over Chrome native messaging, and Chrome for Testing
looks the host manifest up **inside the user data dir** (measured — not in
`~/Library/Application Support`). Since aiui owns the profiles it launches, it plants the
manifest there automatically (`<profile>/NativeMessagingHosts/`) whenever the extension is
loadable — on launch *and* when attaching to an already-running session browser. The global
`aiui extension install-native-host` remains for browsers aiui does not manage (e.g. branded
Chrome with the extension loaded unpacked by hand).

`aiui chrome status` reports whether the bundle exists and whether the chosen browser will
auto-load it; `aiui extension status` shows every native-host manifest, including the launched
profiles'.
