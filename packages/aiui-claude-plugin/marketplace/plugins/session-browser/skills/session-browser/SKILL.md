---
name: session-browser
description: Loaded when this aiui session's Chrome DevTools MCP is attached to a shared, user-visible browser. Covers driving that shared browser safely (etiquette + gotchas), the page-tools MCP surface (page_tools_list / page_tools_call — an app's own tools), the channel's /health and /debug endpoints, and routing to the tab an intent-tool prompt came from (tab ids are hints; MCP pageIds come from list_pages).
---

# Session browser

The browser this session drives through the Chrome DevTools MCP is **shared with the user** — the
tabs you act on are the tabs they are looking at. This session may also see the app's *own* tools
over MCP (below), and the channel server exposes a couple of endpoints worth knowing.

## Page tools: an app's own tools, exposed as MCP

Pages built with `agentToolkit` (from `@habemus-papadum/aiui-viz`) auto-forward their tool surface
to the channel, so an app's own operations appear to this session as two MCP tools alongside
`channel_info`:

- **`page_tools_list`** — discover. Returns one entry per connected page namespace: `clientId`,
  `ns`, `url`, tab identity, and each tool's `name`/`description`/`inputSchema`. Empty when no dev
  page is connected. **Call this first.**
- **`page_tools_call`** — invoke. Args `{ name, args?, ns?, clientId? }`. Omit `ns`/`clientId` when
  the name is unique; if two pages expose the same name the call errors and **lists the
  candidates** — pass `ns` and/or `clientId` to pick one. Every page also carries a synthetic
  `report` tool: a bounded JSON snapshot of page state, the single most useful call.

The intent tool registers itself here too, under namespace `aiui_overlay`
(`report`/`get_config`/`set_config`/`arm`/`get_events`, …) — so you can inspect and reconfigure the
overlay (e.g. switch its transcriber) like any page.

Flow: **list, then call.** After a call that mutates state, **read back in a separate call, not the
same tick** — a `report()` chained straight onto a mutation can see stale values (Solid batches
signal updates until the next task boundary).

Availability: these tools exist only when the channel is running current code. A channel started
before the page-tools feature won't advertise them (and pages served against it stay local) —
relaunch `aiui claude` to pick them up.

## Channel server endpoints

The channel listens on `window.__AIUI__.port`, present on any instrumented page — read it with
`evaluate_script`. On that port:

- `GET /health` — liveness plus a `pageTools` summary (`{ clients, namespaces, tools }`);
  CORS-readable cross-origin.
- `/debug` — the lowering-trace viewer (also standalone). `GET /debug/api/info` reports this
  channel's own info plus `launch`: the OpenAI-key preflight status and how the Chrome DevTools MCP
  was wired (`launch.chromeDevtools` — attach vs launch, endpoint, profile).

If you edit the channel's own source, the `channel_reload` MCP tool (or `POST /debug/api/reload`)
rebuilds its lowering layer in place — live sockets drop and reconnect on their own, the session and
page stay up.

## Routing to the tab an intent-tool prompt came from

Prompts delivered by the aiui channel may begin with a context block like:

> It was submitted from the browser tab "spectra · absorption viewer" at http://localhost:5199/
> (chrome tab id 123456, window id 987654, tab index 4, CDP target id A1B2C3…).

Those ids come from three **different namespaces**. Do not pass one where another is expected:

| Id in the prompt | Namespace | What you can do with it |
| ---------------- | --------- | ----------------------- |
| `chrome tab id`, `window id`, `tab index` | Chrome extension Tabs API | Correlation hints only. No MCP tool accepts them. Tab index drifts as tabs move. |
| `CDP target id` | Chrome DevTools Protocol `Target` domain | Only useful with raw CDP access (`Target.getTargets` → `Target.attachToTarget`). Not accepted by the MCP tools. |
| `pageId` | Chrome DevTools MCP | The **only** id `select_page` accepts — and it exists only in `list_pages` output. Never guess it, never assume it equals the others. |

The workflow:

1. Call `list_pages`.
2. Match the intended page by **URL and title** from the prompt's context block.
3. Call `select_page` with the **pageId `list_pages` returned** for that entry.
4. Verify you got the right page — evaluate `({ href: location.href, title: document.title })`
   and compare against the context block before acting.

If several tabs show the same URL and title (duplicate tabs of one app), disambiguate by
evaluating a marker in each candidate: pages served in the aiui session browser carry the tab
stamp on the document — `document.documentElement.dataset.aiuiTab` — whose JSON `chromeTabId`
you can compare against the prompt's `chrome tab id`.

The prompt's context block may also name the app's **source root** (its Vite root). That is the
code that renders the page in that tab: edit there, and the dev server hot-reloads the tab you
just selected.

## Driving a shared browser

The browser is the user's. Etiquette:

- **Open your own tab** (`new_page`); don't navigate theirs unless asked. **Never act on a tab you
  didn't open**, and **never resize** (it resizes their window). Close your tabs when done.
- The user switches tabs under you — **re-check `[selected]` (or `list_pages`) before every acting
  or mutating call.** For deictic references ("this chart"), screenshot first, act second.
- Announce visible actions in one short transcript line *before* you take them. Pure reads
  (screenshots, console reads, non-mutating evaluates) need no announcement.

Gotchas that have cost real debugging time:

- **Synthetic events** dispatched via `evaluate_script` (KeyboardEvent/PointerEvent) drive most
  instrumented keymaps and canvases, but browser-native behaviors need real APIs — use
  `Selection.addRange` for text selection (not simulated drags), and guard `setPointerCapture`
  (it throws on synthetic pointer ids).
- **Permission-prompting APIs hang.** `getUserMedia`/`getDisplayMedia` block on a pending prompt in
  a real browser and never resolve — stub them *before* driving (reject, for the degraded path, or
  a `canvas.captureStream` stub for fake screen capture). Never leave a prompt dangling on the
  user's browser.
- **Dev servers reload on any file change under the Vite root.** If the user is editing, your page
  state can vanish mid-drive — keep drives atomic and re-check state at the top of each script.
- **`/@fs/` URLs** serve workspace source through the dev server (handy for importing a module into
  a page to probe it), but asset fetches through it can 404 depending on server state — don't build
  a workflow on it.

When the browser wiring misbehaves, read `launch.chromeDevtools` from `GET /debug/api/info` (how
this session's MCP was attached — mode, endpoint, profile) and relay that instead of retrying
blindly.
