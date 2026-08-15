---
name: session-browser
description: Loaded when this aiui session's Chrome DevTools MCP is attached to a shared, user-visible browser. Covers driving that shared browser safely (etiquette + gotchas), the page-tools MCP surface (page_tools_list / page_tools_call — an app's own tools), the channel's HTTP surface (health, debug API, sidecar pages), and routing to the tab an intent-tool prompt came from (tab ids are hints; MCP pageIds come from list_pages).
---

# Session browser

The browser this session drives through the Chrome DevTools MCP is **shared with the user** — the
tabs you act on are the tabs they are looking at. This session also sees connected apps' *own*
tools over MCP (below), and the channel server exposes endpoints worth knowing.

## Page tools: an app's own tools, exposed as MCP

Pages built with `agentToolkit` (from `@habemus-papadum/aiui-viz`) publish their tool surface
into `window.__AIUI__.tools`; the **intent client** (the side panel, or the `/intent/` page)
relays each tab's tools to the channel over one WebSocket per tab. The session sees them as two
MCP tools alongside `channel_info` and `channel_reload`:

- **`page_tools_list`** — discover. One entry per connected page namespace: `clientId`, `ns`,
  `url`, tab identity, `activeTab`, `parked` (the activity bit — a page that routed away parks
  its namespace; parked tools stay listed and callable), `shadowed` (loser of a namespace
  collision), and each tool's `name`/`description`/`inputSchema`. **Call this first.** An
  EMPTY list usually means **no intent client is running** — the page dials nothing itself;
  the panel owns the socket.
- **`page_tools_call`** — invoke. Args `{ name, args?, ns?, clientId? }`. Ambiguity resolves
  automatically in two stages — the active tab first, then a live (non-parked) namespace —
  and only then errors, **listing the candidates**; pass `ns` and/or `clientId` to pick one.

Every aiui app carries a standard surface via `registerStandardTools`: `report`
(`format: "brief" | "full"` — controls, cells, actions, bridge failures, and the live
control→cell dependency edges), `set` (validated write; returns what was written, never a
re-read), `locate` (element → source/cell stamps), plus **one real named tool per registered
`action()`**. A page without its own reporter still gets a synthetic `report` — the single
most useful call.

Flow: **list, then call.** After a call that mutates state, **read back in a separate call,
not the same tick** — Solid batches writes; a same-tick read lies.

Tool-set changes announce themselves: the channel pushes a session line
(`page tools changed: …`) plus `tools/list_changed` when the directory genuinely changes —
never on mere tab switches, activation flips, or same-hash re-registrations.

## Channel server endpoints

Find the port with the **`channel_info` MCP tool**. (There is no `window.__AIUI__.port` — the
page-side global carries only `v`, `sourceRoot`, `tools`, `devKeys`; pages dial nothing.) On
that port:

- `GET /health` — liveness plus bind `host`, LAN `interfaces`, and `pageTools` / `session`
  summaries. CORS-open cross-origin.
- `GET /debug/api/info` — this channel's info plus `launch`: all three vendor-key preflight
  statuses and how the Chrome DevTools MCP was wired (`launch.chromeDevtools` — attach vs
  launch, browserUrl, profile). More under `/debug/api/*`: `channels`, `page-tools` (the
  ledger), `traces`, `frames`, `stats`.
- **The channel serves no HTML.** Pages are sidecars on the same port: the console at `/`
  (302 → `/__aiui/` — dashboard, `/__aiui/debug` trace debugger, `/__aiui/tools` page-tools
  ledger), the intent panel at `/intent/`, the pencil at `/pencil/` (the remote bar's relay
  mounts data/WS routes under `/bar` but serves no page). The channel **auto-opens its
  console dashboard as a tab** in the session browser at boot — one tab you didn't open but
  shouldn't be surprised by.

If you edit the channel's own source, the `channel_reload` MCP tool (or
`POST /debug/api/reload`) rebuilds its lowering layer in place — live sockets drop and
reconnect on their own; the session and pages stay up. **Know its depth boundary**: the
reload re-imports exactly two modules (`processors.ts`, `intent-v1.ts` — see the channel's
`reloadable.ts`). Edits to anything those import — the intent wings (`intent-turn`,
`intent-stt`, `intent-fin`, `intent-resolve`, …), `transcribe.ts`, `realtime.ts`,
`prompt-context.ts`, the shared `@habemus-papadum/aiui-lowering-pipeline` — do **not** take
effect on reload; they need a channel process restart. The in-place reload exists because in
`aiui claude` the process is load-bearing (the stdio MCP pipe to the session, the OS-assigned
port every running dev server holds) — so for deep edits, tell the user a relaunch of
`aiui claude` (or their dev harness) is required rather than assuming the reload covered it.

## Routing to the tab an intent-tool prompt came from

Prompts delivered by the aiui channel open with a context block: a sentence naming the intent
tool (and whether an instrumented aiui app was detected), the tab as a canonical XML marker —

> [current tab: &lt;tab url="…" title="…" aiui-app="true" chrome-tab-id="…" window-id="…"
> tab-index="…" cdp-target-id="…"/&gt;]

— a source-root line ("Relative paths in this prompt are relative to: …"), and a
**browser-tooling alignment sentence**: whether the Chrome DevTools MCP attached to this
session sees the SAME browser the user is viewing, a DIFFERENT one (then trust the prompt's
shots and selections over CDP reads), or no browser at all. Believe that sentence — it is
computed per launch, not boilerplate. The other injection markers (`[screenshot located at
<path>]`, `[selected text: …]`, `[current tab changed: <tab …/>]`, …) are cataloged with real
outputs in the
[Prompt Rendering Reference](../../packages/aiui-claude-channel/docs/prompt-rendering.md).

The `<tab>` ids live in **different namespaces**, and none of them is an MCP pageId:

| Id in the marker | Namespace | What you can do with it |
| ---------------- | --------- | ----------------------- |
| `chrome-tab-id`, `window-id`, `tab-index` | Chrome extension Tabs API | Correlation hints only. No MCP tool accepts them. Tab index drifts as tabs move. |
| `cdp-target-id` | Chrome DevTools Protocol `Target` domain | Only useful with raw CDP access. Not accepted by the MCP tools. |
| `driver-tab` | The plain-page CDP host's own tab handle | Another hint; same rules. |
| `pageId` | Chrome DevTools MCP | The **only** id `select_page` accepts — and it exists only in `list_pages` output. Never guess it. |

The workflow:

1. Call `list_pages`.
2. Match the intended page by **URL and title** from the context block.
3. Call `select_page` with the **pageId `list_pages` returned** for that entry.
4. Verify — evaluate `({ href: location.href, title: document.title })` and compare against
   the context block before acting.

If several tabs show the same URL and title (duplicate tabs of one app), there is no page-side
tab stamp to read — disambiguate by observable state (evaluate a distinguishing value in each
candidate), or ask the user which tab they mean.

The context block's **source root** is the code that renders the page in that tab: edit
there, and the dev server hot-reloads the tab you just selected.

## Driving a shared browser

The browser is the user's. Etiquette:

- **Open your own tab** (`new_page`); don't navigate theirs unless asked. **Never act on a tab
  you didn't open**, and **never resize** (it resizes their window). Close your tabs when done.
- The user switches tabs under you — **re-check `[selected]` (or `list_pages`) before every
  acting or mutating call.** For deictic references ("this chart"), screenshot first, act
  second.
- Announce visible actions in one short transcript line *before* you take them. Pure reads
  (screenshots, console reads, non-mutating evaluates) need no announcement.
- **Label your turns.** If you drive the intent tool (or any instrumented page) in a tab you
  opened, first run `sessionStorage.setItem("aiui-actor", "agent")` in that tab — traces you
  produce are then badged `agent` instead of blending into the user's own. Per-tab, explicit
  opt-in (default `human`; `navigator.webdriver` is deliberately ignored — it is browser-wide
  here and would mislabel the user). Remove the key to revert.

Gotchas that have cost real debugging time:

- **Synthetic events** dispatched via `evaluate_script` (KeyboardEvent/PointerEvent) drive most
  instrumented keymaps and canvases, but browser-native behaviors need real APIs — use
  `Selection.addRange` for text selection (not simulated drags), and guard `setPointerCapture`
  (it throws on synthetic pointer ids).
- **Media capture is pre-answered, not prompted.** The session browser launches with
  `--auto-accept-camera-and-microphone-capture` and `--auto-accept-this-tab-capture`, so
  `getUserMedia` and `getDisplayMedia({ preferCurrentTab: true })` resolve with the real
  devices, no picker, no gesture. Two traps remain: whole-screen capture (without
  `preferCurrentTab`) still shows a picker — never leave one dangling on the user's browser;
  and a Chrome spawned from a shell **without the macOS Screen-Recording grant inherits that
  lack and the call hangs** — never trust a capture measurement taken from an agent-spawned
  shell (details: [chrome.md](../../packages/aiui/docs/chrome.md)).
- **Dev servers reload on any file change under the Vite root.** If the user is editing, your
  page state can vanish mid-drive — keep drives atomic and re-check state at the top of each
  script.
- **`/@fs/` URLs** serve workspace source through the dev server (handy for importing a module
  into a page to probe it), but asset fetches through it can 404 depending on server state —
  don't build a workflow on it.

When the browser wiring misbehaves, read `launch.chromeDevtools` from `GET /debug/api/info`
(how this session's MCP was attached — mode, endpoint, profile) and relay that instead of
retrying blindly.
