# The plugin restructure — plan of record

Owner-decided 2026-07-14. The app-side aiui integration sheds its dev-server
magic: the Vite plugin moves to viz with two jobs only, the `__AIUI__` global
becomes a runtime fact (production included), and channel connectivity
arrives from OUTSIDE via the intent client — never from the app. Three
tranches; T1 landed as `eb3d60e`.

## T1 — DONE (`eb3d60e`)

`@habemus-papadum/aiui-viz/vite` is the plugin: (1) the source-locator pass —
applies to serve AND build (factory identity is load-bearing; a violating
build fails in prod exactly as in dev), `data-source-loc` stamps EMIT
dev-only; (2) a dev-only `sourceRoot` HTML seed. Nothing else — no port, no
page-side `/tools` dialer, no session bus, no overlay mounting.

`window.__AIUI__` installs from the viz RUNTIME (`aiui-global.ts`,
`ensureAiuiGlobal()` — called by `agentToolkit`, so any instrumented page
carries it, prod included). Its `tools` is a REGISTRY —
`register(ns, tools)` (replace-by-namespace, the old bridge's contract) +
`list()/call()/onChange()` — callable by in-page internal clients (owner:
door open, no use case yet) exactly as by the T2 bridge. An existing tools
surface (the old overlay ws bridge) is respected, never clobbered. The
overlay's `source-locator.ts` is a re-export shim until T3.

## T2 — the client-side tools bridge

Pages populate their registry; the PANEL bridges it to the channel. Protocol
facts (read from `aiui-claude-channel/src/page-tools.ts` and the old
`overlay-tools.ts` / `aiui-extension/src/panel/tools-link.ts`):

- The directory is CONNECTION-SCOPED: each `/tools` websocket = one client;
  socket close drops that client's namespaces. Messages: client sends
  `{v:1, type:"register", ns, tools:[{name,description,inputSchema}], tab?}`,
  receives `{type:"call", callId, ns, name, args}`, replies
  `{type:"result", callId, ...}`. `{v:1, type:"activation",
  tab:{chromeTabId, windowId}, active:true}` flags the active tab
  (directory-global; steers ambiguous `page_tools_call`s).

Design (owner-confirmed, incl. "one literal WebSocket per tab-with-tools"):

1. **Page side**: the MAIN world watches `__AIUI__.tools.onChange` and
   relays DESCRIPTORS ONLY as a new `PageReport {kind:"tools",
   registrations:[{ns, tools:[{name,description,inputSchema}]}]}`. A new
   page capability `toolsCall {ns, name, args, callId}` runs
   `registry.call()` and reports `{kind:"toolsResult", callId, ok,
   value|error}`. CDP bootstrap is already main-world (use
   `__AIUI__.tools` directly; NO import — it is stringified). MV3:
   `content-main.ts` (main world) does the watching/calling and relays via
   `postMessage` to `content.ts` (callId round trips).
2. **Panel side** (a lanes-adjacent module, e.g. `src/tools-link.ts`): a
   map tab → WebSocket to `ws://127.0.0.1:<port>/tools`. Open on a tab's
   first non-empty tools report (register with `tab` identity); re-register
   on change; close on tab close or empty registration; re-dial all on
   channel reconnect. Forward `call` → `toolsCall` capability → `result`.
   Send `activation` on `targeting.onActiveTabChange`. MV3 tab identity is
   real (`chromeTabId`/`windowId`); the CDP tier sends its own tab numbers
   as hints (accepted DECIDE — they are correlation hints, not keys).
3. **Zero channel-side changes.** Socket-per-tab means tab-close cleanup is
   free (connection close) and same-namespace-in-two-tabs never collides
   (distinct clients; `page_tools_call` already disambiguates by clientId +
   activeTab steering).
4. Tests: registry→report mapping (both page scripts' shape), the panel
   socket manager over a fake ws factory (register/re-register/close
   lifecycles, activation on tab switch), one call round trip.

## T3 — the migration sweep

- Migrate 7 vite configs to `import aiui from "@habemus-papadum/aiui-viz/vite"`:
  `demos/july09`, `demos/gallery`, `demos/twins`, `demos/walkthrough`,
  `packages/aiui-extension`, `packages/aiui-test-app`,
  `packages/create-aiui/templates/app` (the template fixes BOTH scaffolders).
- Gut `aiui-dev-overlay/src/vite.ts`: port injection, `installToolsBridge`
  injection, session-bus injection, overlay mounting all die; keep a
  deprecated thin wrapper (locator + loud deprecation note) one release.
  The page-side session bus (`__AIUI__.session`) drops with it — its
  consumers were the demoted overlay modality and the being-re-envisioned
  paint host; the channel's `/session` hub and the PANEL's connection are
  untouched.
- Docs: `docs/guide/web-intent-tool.md` (the plugin-internals note),
  `frontend-for-agents`, root `CLAUDE.md` (layer-3 description), the
  `frontend-design` skill if it names the old plugin.
- `pnpm test:packaging` + full `-r` gates; the old `.port` consumers
  (devtools panel discovery) already have their replacement (the client
  discovers channels itself).
