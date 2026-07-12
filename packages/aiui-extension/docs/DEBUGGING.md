# Debugging access to the extension — what works, what doesn't, what's next

> The record of how an agent session (and a human) can see into this extension during the dev
> workflow, as measured live on 2026-07-12. Companion to PHASE-A.md (§7.10 logged the
> measurements) and to the **session-browser skill**
> (`packages/aiui-claude-plugin/marketplace/plugins/session-browser/skills/session-browser/SKILL.md`),
> which teaches sessions how to drive the shared browser but — as of today — says nothing
> about extension surfaces. The wishlist at the bottom includes fixing that; nothing in the
> skill has been updated yet.

## The surfaces and where they live

| Surface | CDP target | Console goes to |
|---|---|---|
| Side panel (`src/panel/`) | a normal `page` target, `chrome-extension://ngak…/src/panel/index.html` | its own document console ("Inspect" via right-click on the panel) |
| Service worker (`src/sw.ts`) | a `service_worker` target | the SW console (chrome://extensions → "service worker" link) |
| Content scripts (`src/content.ts`) | no target of their own — an isolated world inside each TAB's `page` target | **the tab's console** |
| Offscreen capture doc | a target only while it exists (capture moments) | its own console, rarely alive long enough to matter |

## What works today (measured)

- **Reloading the extension from a terminal** — `aiui extension reload` (aiui-util's
  `reloadExtension`): finds a context of the extension over CDP (service worker → any extension
  page → an inert wake page opened in a background tab, because an idle MV3 worker leaves no
  target at all) and evaluates `chrome.runtime.reload()` there. `evaluateInExtension` is the same
  machinery with the answer kept — how the CLI asks the browser *which artifact it is running*.
  Both verified live on 2026-07-12 (CfT 150).
- **Installing / re-pointing it from a terminal** — CDP's `Extensions.loadUnpacked` works on the
  session browser's debug endpoint (measured, CfT 150; returns the key-pinned id). That is "Load
  unpacked" with no human, and it is how `aiui extension dev`/`reload` fix a browser that is
  pointed at the wrong artifact directory.
- **Raw CDP against the session browser's debug endpoint** — full access to everything above.
  The endpoint comes from `DevToolsActivePort` in the profile dir
  (`.aiui-cache/chrome/<profile>/`); `GET /json` lists targets; a WebSocket to a target's
  `webSocketDebuggerUrl` gives `Runtime.evaluate`, and `Runtime.enable` **replays the buffered
  console** (how the panel's console was read live, catching a real HMR error in the act).
  The M7/M8 platform measurements were made this way — `sendNativeMessage` executed *inside*
  the MV3 service worker. Recipe scripts from those probes are trivially recreatable
  (~30 lines of node, native WebSocket).
- **Content-script logs via the tab**: `console.*` from `content.ts` lands in the page's
  console — readable by any tool that can read a tab's console (including the chrome-devtools
  MCP's `list_console_messages`, when the MCP is attached at all — see below).
- **The panel's leveled `[aiui]` narration** (log.ts + the `logLevel` control:
  quiet/info/debug) — the deliberate routine-feedback channel, designed to be read here.
- **Human paths**: right-click panel → Inspect; chrome://extensions → service-worker link and
  "views"; the dev server's own output (HMR lines name every hot-swapped module).

## Dev-loop traps that make verification lie (measured 2026-07-12 — then fixed the same day)

CRXJS **snapshots each HTML page's entry bundle when the dev server starts**, and Chrome holds
the extension directory it last read. Consequences that cost three debugging rounds:

- Edits to existing modules reach the OPEN page via HMR, but a **full page reload re-fetches the
  startup snapshot** — the page silently runs OLD code. Any verification that reloads (every CDP
  probe here does) therefore tests the snapshot, not your edit.
- A **new module file** (or a changed export map) is not in the snapshot's graph at all: the page
  renders the old tree with no error.
- Reloading the extension **while Vite is rewriting the artifact** caches a partial extension: a
  panel document with zero scripts, no title, no error.

**All three are now the CLI's problem, not yours** (2026-07-12):

- The dev artifact lives in **`dist-dev/`**, separate from the release `dist/`, and it stamps
  itself complete (`aiui-dev.json`, written last) with a `runId` also served at
  `/@aiui/dev-run` (kit: `aiui-webext/src/dev-stamp.ts`).
- **`aiui extension dev`** (run it from the project whose session browser you use — it picks the
  profile) starts Vite, waits for that stamp, then reloads the extension over CDP, then reports
  which artifact the browser is really running. **`aiui extension reload`** is the same reload on
  its own. So "restart the dev server → reload the extension → re-open the panel" is one command,
  in the right order, every time.
- The panel **says** when it is stale or serverless (`src/panel/boot.ts` — banner + Reload
  button), so a lying verification announces itself instead of looking like your bug.

**Rule (unchanged in spirit): after adding a module or touching exports, restart the dev loop
before believing any reload-based verification** — but restart it with `aiui extension dev`, which
leaves Chrome in the right state. The side panel still has to be re-opened by a human (a panel can
only be opened by a user gesture) — though its *document* can be checked without one (see above).

## Know what a CRXJS dev artifact IS, or you will misdiagnose it (measured 2026-07-12)

This cost a false alarm, so it is written down. **A dev build emits no entry bundles at all.**

| in `dist-dev/` | what it is |
|---|---|
| `manifest.json` | points at loader stubs, not bundles |
| `service-worker-loader.js` | three `import 'http://localhost:5317/…'` lines |
| `src/content.ts-loader.js`, `src/content.ts.js` | the content script, via the dev server |
| `src/panel/index.html` | **CRXJS's "loading page"**, not your HTML |
| `assets/loading-page-*.js` | that page's script — *the only file in `assets/`* |

The panel's real document arrives at **runtime**: the loading page polls `/@crx/dev-ready`, then
reloads, and the **service worker proxies the extension's own origin to the dev server**, which
serves the transformed HTML and modules. So:

- `dist-dev/assets/` containing only `loading-page-*.js` is **correct**. The hashed
  `assets/index.html-*.js`, `assets/sw.ts-*.js`, `assets/content.ts-*.js` bundles you may go
  looking for are **production** output — if you find them in `dist/` with fresh timestamps,
  someone ran a build (e.g. `pnpm test:packaging`, which does `pnpm -r build`), not the dev server.
- **A panel stuck on "CRXJS DEV MODE / Connecting to the Vite dev server…" means the dev server is
  down** (or was never reachable), *not* that the extension is broken. That page is CRXJS's, not
  ours, so the panel's own watchdog banner cannot appear there — this is the one blank-ish state
  the watchdog can't narrate. It carries CRXJS's own "Reload Extension" button; the real fix is
  `aiui extension dev`.
- The honest completeness question for a dev artifact is therefore *"does every file the manifest
  names exist?"* — which the build now checks before stamping (kit: `missingManifestFiles`), and
  refuses to stamp when it doesn't.

## Verifying the panel's RENDER without a human (measured 2026-07-12)

The side panel can only be *opened* by a user gesture — but the panel **document** can be
inspected without one, and this is the check that settles "is the panel actually working?":

- **Do NOT open it with CDP** (`PUT /json/new`, `Target.createTarget`, `Page.navigate`). An
  extension page in a CDP-created tab **never commits**: `document.readyState` stays `"loading"`,
  there is no `<head>`, the console is silent. Measured against BOTH artifacts — the *production*
  build hangs identically — so it is a property of CDP-driven tabs, not of the dev loop. Believing
  that probe cost a round of "the panel is broken" that wasn't.
- **Open it through the extension's own API instead**: evaluate, in the service worker,
  `chrome.windows.create({url: chrome.runtime.getURL('src/panel/index.html'), type:'popup',
  focused:false})`, then attach to the resulting page target and read
  `document.title` / `#root.childElementCount` / `#aiui-boot-banner`. A healthy dev panel answers
  `title: "aiui"`, `rootKids: 7`, no banner. Close it with `chrome.windows.remove(id)`.

## What does NOT work today (measured or blocked)

- **The session's chrome-devtools MCP after a browser relaunch.** The MCP's attach URL
  (`--browser-url`) is captured ONCE at `aiui claude` launch. Relaunch the browser and the MCP
  keeps dialing the dead endpoint (measured: stale `:52300` vs live `:52916`) — every MCP
  browser tool fails with "Could not connect to Chrome" for the rest of the session.
- **The MV3 service worker via the MCP, ever**: it is not a `page`, and the MCP's tools are
  page-shaped. Raw CDP is the only agent path to the SW.
- **Unverified (blocked by the stale attach)**: whether the MCP's `list_pages` surfaces the
  side panel as a selectable page (expected yes — it is a page target; puppeteer generally
  lists extension pages), and whether `list_console_messages`' `serviceWorkerId` filter can
  reach an extension SW's messages. Both need one measurement in a fresh session.
- **The aiui DevTools panel extension** monitors the CHANNEL (server stats, traces), not this
  extension — no overlap today.
- **No tools surface of the panel's own**: `agentToolkit`/`registerStandardTools` are not
  wired (deliberately deferred — PHASE-A.md §7.6), so a session cannot `report()`/`set` the
  panel through `page_tools_*` the way it can an instrumented app page.

## Wishlist (recorded, not yet done)

1. **MCP attach resilience** (aiui CLI): stop freezing the browser URL at launch — rediscover
   via `DevToolsActivePort` when the attach fails (a thin wrapper around chrome-devtools-mcp,
   or an upstream `--browser-url-file`-style flag). This is the single highest-leverage fix:
   today one browser restart silently lobotomizes the session's browser tooling.
2. **Panel `agentToolkit` + `/tools` forwarding** (lands with Phase C): `report` (phase, ink,
   binding, toasts, log tail), `set` (logLevel, inkFade, shotFlash, uiScale), and the §13.6
   verbs as actions — first-class agent introspection with no CDP at all, through the
   existing `page_tools_list`/`page_tools_call` surface the skill already teaches.
3. **A packaged probe helper** (until 1/2 exist): `extension-debug.mjs`-style script — list
   extension targets, dump a target's buffered console, evaluate an expression — the raw-CDP
   recipe made repeatable instead of rewritten per session.
4. **Session-browser skill update**: add an "extension surfaces" section — the target table
   above, the raw-CDP recipe, the MCP limitations (stale attach; SW unreachable), and the
   convention that the panel narrates at `logLevel` for exactly this consumption.
5. **Measure the two unknowns** in a fresh session (MCP list_pages × side panel;
   `serviceWorkerId` × extension SW) and record the answers here.
6. **Maybe**: forward the panel's `[aiui]` log ring to the channel (a small log sink), so the
   session can read panel narration without any browser tooling. Weigh against 2, which may
   cover it via `report`.
