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
