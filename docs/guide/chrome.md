# The Agent's Browser

`aiui claude` attaches Google's
[Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) to the session by
default, so the agent can drive a real Chrome: navigate, click, fill forms, screenshot, read the
console, evaluate JavaScript. See
[⚠️ Read before running](./warning#_3-the-agent-gets-a-browser-by-default) for what that implies
before deciding it's on.

The design goal is one **session browser**: a single, user-visible Chrome that you and the agent
share — you click around in the same tabs the agent drives, the agent screenshots the page you're
looking at, and the [aiui DevTools panel](./devtools) is loaded in it. That's what makes deictic
work ("make *this* wider") possible.

Sharing a browser needs manners, so whenever the Chrome DevTools MCP is attached, `aiui claude`
also loads the **session-browser skill** from the bundled
[plugin marketplace](/packages/aiui-claude-plugin/). Today it's a deliberate stub; the drafted
guidance (announce each visible browser action *before* taking it, prefer new tabs over hijacking
yours, never close tabs the agent didn't open) is parked in the package's `drafts/` pending
review. Sessions without the browser skip the skill entirely.

## On and off

| Situation                                          | Result                                     |
| -------------------------------------------------- | ------------------------------------------ |
| Default                                            | Attached                                   |
| `CI` set in the environment                        | Off (`--aiui-chrome` forces it back on)    |
| `--aiui-no-chrome`                                 | Off, beats everything                      |
| `chrome.enabled: false` in [config](./config)      | Off (a per-launch `--aiui-chrome` still wins) |

## How the browser connects: attach vs launch

chrome-devtools-mcp can either *launch* its own browser or *attach* to a running one's DevTools
debug endpoint. aiui defaults to **attach**, because a browser the MCP launches privately is
invisible until the agent first touches it and is never the window you're working in. The decision
ladder at `aiui claude` time:

1. **`chrome.browserUrl` configured** → attach to that endpoint verbatim. The browser is managed
   elsewhere — usually on your local machine while the session runs remotely (see
   [Remote Development](./remote)). Nothing browser-related happens on the session's machine.
2. **A session browser is already running on this profile** → attach to it. Discovery is
   Chrome-native: an instance started with a debug port writes `DevToolsActivePort` into its user
   data dir; aiui reads it and probes the endpoint. Start one yourself anytime with
   [`aiui browser`](#aiui-browser-and-aiui-open).
3. **Interactive launch, nothing running** → aiui starts the session browser now — visible from
   the first moment, on the project profile, with the devtools panel loaded — and attaches. The
   browser is deliberately independent of the Claude process: it's your window too, and it
   survives the session (and serves the next one, via rule 2).
4. **Otherwise** — `chrome.mode: "launch"` in config, a non-interactive session (`-p`, no TTY)
   with nothing running, or a failed start — classic **launch mode**: chrome-devtools-mcp starts
   its own private browser lazily, on the agent's first browser tool call. This is the right mode
   for headless one-shots; set `chrome.mode: "launch"` to make it your default. (Don't mix modes
   on one profile: a launch-mode session can't start Chrome on a profile a session browser
   already holds.)

## Chrome for Testing: the recommended browser

Whenever aiui launches a browser (rules 3 and 4), the binary it recommends — and manages — is
**Chrome for Testing** (CfT), Google's automation build of Chrome. It is *not* a different
browser and has no extra features: same engine, same behavior, same security (sandboxing intact)
as branded Chrome of the same version. The differences are operational, and they're exactly what
an agent-driven browser wants:

- **No auto-update**, and every version stays downloadable — your automation runs a pinned,
  reproducible browser, not whatever stable updated itself to overnight.
- **No first-run friction** — default-browser prompts, sign-in promos and similar branded-Chrome
  UX are absent.
- **Automation-hostile branded restrictions don't apply** — notably `--load-extension` still
  works (branded Chrome ≥ 137 ignores it), so the aiui DevTools panel loads automatically.

One CfT wart has no cure: the *"Chrome for Testing … is only for automated testing"* infobar is
baked into headed CfT — no flag removes it ([puppeteer#10516]). If it bothers you more than the
benefits above, point config at branded Chrome (`chrome.channel: "stable"` or
`chrome.executablePath`) — the trade is loading the DevTools panel by hand (chrome://extensions →
Load unpacked, once per profile), since branded Chrome ignores `--load-extension`.

[puppeteer#10516]: https://github.com/puppeteer/puppeteer/issues/10516

### Media prompts are pre-answered

The session browser launches with `--auto-accept-camera-and-microphone-capture` and
`--auto-accept-this-tab-capture`: microphone/camera permission prompts auto-accept (the *real*
default devices — no fakes), and the current-tab capture the shot tool and the paint host ask
for (`getDisplayMedia({ preferCurrentTab: true })`) skips the share picker — tab capture needs
no macOS Screen Recording grant. Without these, dictation re-prompts per **origin** — every
dev-server port is a distinct origin — and Chrome never persists screen-share consent at all.
(Not the older `--use-fake-ui-for-media-stream`: that flag also hijacks the `getDisplayMedia`
picker and auto-selects the *entire screen*, which fails with `NotReadableError` when the CfT
binary lacks the macOS Screen Recording permission — it silently broke the paint host's screen
share.) This is a deliberate posture choice for a dev browser that already runs an
unauthenticated debug port (see [the warning](./warning)): treat every page you open in it as
able to hear the mic and see the tab without asking.

### The managed install

Unless config picks a browser explicitly (`chrome.executablePath` / `chrome.channel`), every
**interactive** launch that needs a browser syncs the managed CfT — never in CI, never without a
TTY, never in `-p`/`--print` mode; those sessions just use whatever is already installed:

- **CfT not installed** → you're offered a download (yes / not now / never). "Not now" snoozes
  the offer for a day and that launch uses your regular Chrome; "never" writes
  `chrome.forTesting: "off"` to your user config.
- **CfT installed but stale** (checked against latest stable at most once per day, short network
  timeout, silently skipped offline) → *"Your Chrome for Testing is out of date. Update?"*
  - **yes, just this once** — update now, ask again next time.
  - **automatically** — update now and write `chrome.forTesting: "auto"`: from then on it stays
    current without asking.
  - **skip** — keep the current version and don't ask again *for this version*.
  - **never ask again** — writes `chrome.forTesting: "off"`.
- **CfT installed and current** → it's simply used. This also holds with `forTesting: "off"` —
  "off" silences checks and prompts, it doesn't un-prefer an install you made deliberately.

The knob is `chrome.forTesting` in [config.json](./config): `"prompt"` (default) / `"auto"` /
`"off"`. Prompt answers are persisted to the **user-level** config, never the project file.

## The commands

```sh
aiui browser            # start (or find) the session browser; prints its debug endpoint
aiui browser --tunnel <host>   # …and reverse-tunnel it to a remote box (the remote-dev local half)
aiui open <url>         # open a URL as a tab in the session browser
aiui chrome install     # install (or bring to latest stable) the managed CfT
aiui chrome update      # same thing, by its other name
aiui chrome status      # what would launch/attach from this directory, and why
aiui chrome extension   # print the devtools extension path (for Load unpacked)
```

### `aiui browser` and `aiui open`

`aiui browser` makes the session browser exist independently of any Claude session: run it before
`aiui claude` to have the window up first, or — the headline use — on your **local machine** in
remote development, where `--tunnel <[user@]host>` launches the browser, reverse-tunnels its
debug port to the remote box on a fixed remote port (`--remote-port`, default 9222), and prints
the `aiui claude --aiui-browser-url …` command to paste there — see
[Remote Development](./remote). It's idempotent: if the profile's browser is already up, it
reports the existing endpoint. Options: `--profile <name>`, `--data-dir <path>`, `--port <n>`
(the *local* debug port — rarely needs pinning), `--headless`, `--open <url>`,
`--tunnel <[user@]host>`, `--remote-port <n>`.

`aiui open http://localhost:5173` is the answer to "the Vite link opens my *default* browser":
open the app as a tab in the session browser instead, so you and the agent are looking at the
same page. (`aiui vite` does this automatically when the dev server comes up — `--aiui-no-browser`
opts out, and headless environments get a printed URL instead of a window.)

`aiui chrome status` is the diagnostic to reach for first: the managed CfT install and its
freshness, how *this* directory would connect (attach/launch, any running session browser),
which browser and user data dir it would use, the profiles that exist here, and whether the
devtools panel will auto-load. For a *running* session, the [DevTools panel](./devtools)'s
Server tab shows the same wiring **as the session actually saw it at launch** — `aiui claude`
hands the channel server a launch summary (`--launch-info`), surfaced at `/debug/api/info`.

One aside on `--help`/`--version`: they're inert on the wrapper commands. `aiui claude --help`
prints aiui's own flag summary and then claude's help (two outputs, back to back) without
touching config, the browser, or Chrome for Testing — same idea for `--version` and for
`aiui vite`.

## Where everything lives

| What                                   | Where                                                                   |
| -------------------------------------- | ----------------------------------------------------------------------- |
| Chrome **user data dirs** (profiles)   | `.aiui-cache/chrome/<profile>` under the directory `aiui claude` runs in (default profile: `default`); gitignored, project-local |
| The session browser's **debug port**   | `DevToolsActivePort` inside the profile dir — written by Chrome itself; aiui's discovery reads it (plus an informational `aiui-browser.json` breadcrumb) |
| Managed **Chrome for Testing** builds  | `~/.cache/aiui/chrome/` — user-level (respects `AIUI_CACHE`/`XDG_CACHE_HOME`), shared across projects, plus its `update-state.json` bookkeeping |
| [Config](./config)                     | `~/.cache/aiui/config.json` (user) and `.aiui-cache/config.json` (project) |
| chrome-devtools-mcp's own default      | `~/.cache/chrome-devtools-mcp/chrome-profile` — only if you run it *without* aiui; aiui always pins the profile |

## Profiles: persistent and project-local

The session browser never touches your personal browser profile. Because the project profile
persists, browser state accumulates usefully across sessions: logins, DevTools settings, manually
installed extensions.

- `--aiui-chrome-profile <name>` — use `.aiui-cache/chrome/<name>` instead. Naming a new profile
  creates it; that's the whole lifecycle. (`rm -r` the directory to reset one.)
- `--aiui-chrome-data-dir <path>` — use an explicit directory anywhere on disk, e.g. to share one
  profile across projects.
- The same choices can be made durable with `chrome.profile` / `chrome.dataDir` in
  [config.json](./config); flags win over config for a single launch.

Two things to keep in mind: whatever you log into *inside* that browser stays in the profile and
is reachable by the agent in later sessions; and concurrent `aiui claude` sessions in the same
project **share** the one session browser (that's attach mode working as intended — Chrome allows
only one instance per user data dir anyway; give a session its own `--aiui-chrome-profile` if you
want isolation instead).

## The aiui DevTools panel: when is it available?

The [panel](./devtools) ships **inside the npm package**
(`@habemus-papadum/aiui-devtools-extension`, `extension/` prebuilt), so it's present however you
got aiui:

- **Dev checkout of this repo** — every browser start rebuilds it from source first (a full `tsc`
  is ~0.3 s, so it's rebuilt every time rather than tracking staleness; a compile failure warns
  loudly and continues with the last build). `chrome.buildExtension: false` skips the rebuild.
- **aiui as a dependency in your project** — the published package contains the built extension;
  nothing to compile. `aiui chrome extension` prints its path.

Whether it *loads* depends on the browser:

- **Chrome for Testing (or Chromium)** — auto-loads via `--load-extension` whenever aiui starts
  the session browser (and in launch mode too). This is the main reason CfT is the recommended
  browser.
- **Branded Chrome (installed stable, or any `channel`)** — ≥ 137 ignores `--load-extension`
  (the flag was removed because malware abused it), so auto-load is a no-op. The fix is
  manual-but-once: in the session browser, `chrome://extensions` → Developer mode → Load
  unpacked → the directory `aiui chrome extension` prints. The persistent profile remembers it
  for every later session. Interactive launches print a one-time note per profile reminding you
  of exactly this (then a marker in the profile keeps it quiet).

## The intent-tool extension rides along

The [browser-extension intent tool](../proposals/browser-extension-intent-tool.md)
(`@habemus-papadum/aiui-extension` — per-window side panel, capture, ink, page tools) is
auto-loaded the same way, appended to the same `--load-extension` list. Two deliberate
differences from the DevTools panel:

- **It has two artifacts, and aiui picks one.** `dist-dev/` is what its Vite dev server writes
  (CRXJS loader stubs — inert without that server); `dist/` is the standalone production build.
  The launcher loads **`dist-dev/` when its dev server is answering**, and `dist/` otherwise — so
  a stale dev artifact can never hijack a launch, and "just use the tool" needs no dev server at
  all. With neither present, it prints a note telling you how to get one.
- **aiui never builds it.** Building from the launcher would be a surprise write into someone
  else's dev loop. Whoever owns the loop owns the artifact:

  ```sh
  aiui extension dev      # develop it: Vite + an ordered reload of this project's browser
  pnpm -C packages/aiui-extension build   # just use it: standalone dist/, no server
  aiui extension reload   # make the running browser re-read whichever artifact applies
  ```

- **A dev artifact with no dev server behind it** still loads (you asked for it), but interactive
  launches warn loudly — otherwise every surface comes up on CRXJS's "cannot connect" page, which
  reads as "broken" instead of "not being served".

Chrome installs an unpacked extension **by path**, so a profile that was loaded against one of
the two directories keeps re-reading that one. `aiui extension reload` checks (it reads the
extension's own dev stamp back out of the browser) and says so when the browser is running the
production build while you are developing.

The extension's channel discovery runs over Chrome native messaging, and Chrome for Testing
looks the host manifest up **inside the user data dir** (measured — not in
`~/Library/Application Support`). Since aiui owns the profiles it launches, it plants the
manifest there automatically (`<profile>/NativeMessagingHosts/`) whenever the extension is
loadable — on launch *and* when attaching to an already-running session browser. The global
`aiui extension install-native-host` remains for browsers aiui does not manage (e.g. branded
Chrome with the extension loaded unpacked by hand).

`aiui chrome status` reports which shape (if any) it found and whether the chosen browser will
auto-load it; `aiui extension status` shows every native-host manifest, including the current
project's profiles.

## Choosing a browser explicitly

Config keys that override the defaults:

- `chrome.mode` — `"attach"` (default) or `"launch"`, as described
  [above](#how-the-browser-connects-attach-vs-launch).
- `chrome.browserUrl` — attach to this endpoint and manage nothing; the
  [remote development](./remote) key.
- `chrome.executablePath` — launch exactly this binary (a CfT you manage yourself, a Chromium, a
  nightly build…). Disables the CfT sync.
- `chrome.channel` — `"stable" | "beta" | "dev" | "canary"`: launch an *installed* branded
  Chrome release channel, e.g. to exercise upcoming Chrome behavior. Also disables the CfT sync;
  being branded, these can't auto-load the panel. Mutually exclusive with `executablePath`.
- `chrome.debugPort` — pin the session browser's debug port (default: OS-assigned) when
  something else needs to find it, like an ssh tunnel.
