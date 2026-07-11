# A Chrome extension as the intent-tool host

## Context

The web intent tool is delivered today by the `aiuiDevOverlay()` Vite plugin: an inline script
seeds `window.__AIUI__` with the channel port, a virtual mount module calls `mountIntentTool()`,
and everything — widget, engine, thread socket, capture grant, ink — lives and dies with one
document (`apply: "serve"`: the tool structurally cannot exist outside the dev server). That
design was the right stepping stone: it needed no install, no permissions, and it let the whole
pipeline (engine → wire → lowering → session) mature inside the easiest possible host.

Its limits are now visible and structural:

- **Continuity is an accident of DOM lifetime.** A turn dies with its document (see
  `spa-navigation-and-turn-continuity.md`); it cannot span tabs at all.
- **Only Vite-served pages participate.** The tool can't collect intent about anything else the
  developer is looking at — docs, dashboards, a deployed build, a second app.
- **Capture is flag-dependent.** Picker-free capture rides `--auto-accept-this-tab-capture` plus
  a CDP-injected marker, so it only works in the session browser (`docs/guide/screen-capture.md`).

This proposal moves the host into a **Chrome MV3 extension**: the overlay comes from the
extension, works on instrumented and plain pages alike, and the session model changes from
per-document to **per browser window**. The web intent tool remains — as the in-page reference
implementation and debugging baseline (§10) — but the extension is the evolution path.

A large fraction of the design was de-risked by research (July 2026); facts below are sourced in
§13. The one recurring theme: several load-bearing behaviors are documented nowhere and need
hands-on **measurement** before the design freezes — §12 separates the spikes worth running now
from the ones that can wait.

## 1 · The shape

Five extension surfaces, each doing the only thing it can do:

- **Side panel — the per-window brain.** `chrome.sidePanel`'s *default* behavior is exactly the
  per-window session model: a global panel persists across tab switches within a window, and each
  window has independent open/closed state. The panel is a full extension page whose document
  stays alive while open — so it hosts the things that must outlive any tab: the **intent-pipeline
  `Engine`** (the turn), the channel websockets (`/ws` thread socket, `/session` bus, `/tools`),
  the channel picker, and the **trace viewer** (`debug-ui` is framework-free and already proven
  inside an extension page — the DevTools panel bundles it via esbuild today). Turn state mirrors
  to `chrome.storage.session` for crash/reload recovery — strictly better than today's
  sessionStorage mirror because no page navigation can clear it.
- **Content scripts — the per-tab limbs, and almost nothing else.** With the side panel as the
  primary surface, the in-page footprint shrinks to what *must* be in the page: the **ink
  canvas**, the **selection watcher**, a thin **keymap relay** (arming keys and gesture keys are
  page-level keystrokes; Chrome `commands` shortcuts are the global fallback), and a minimal
  MAIN-world probe (declarative `"world": "MAIN"`, Chrome 111+) that reads `window.__AIUI__` /
  detects a page-hosted overlay / observes page tool registrations. No pill, no command bar, no
  preview strip, no config UI in the page — those all move to the panel (measured, 2026-07-10:
  tab-scoped captures — pane-scoped tabCapture and `captureVisibleTab` — do **not** include the
  side panel, so tool chrome in the panel is structurally outside every captured frame; only
  window-level `getDisplayMedia` sees it). Events relay to the panel over a `runtime.Port`; the
  engine is not here.
- **Service worker — plumbing.** Tab lifecycle (`tabs.onActivated`/`onUpdated`/`onRemoved`,
  `splitViewId` changes), tab-identity stamping (absorbing what
  `aiui-devtools-extension`'s background worker does today), `tabCapture.getMediaStreamId()`,
  offscreen-document management, native-messaging port. WebSocket activity resets the SW idle
  timer (Chrome 116+), but the panel is the preferred socket host — the SW holds no
  turn state.
- **Offscreen document — the capture room.** Consumes tabCapture stream IDs via `getUserMedia`
  (the documented MV3 pattern, Chrome 116+), grabs shot frames, runs the share sampler, and
  hosts the iPad frame source (§6). One offscreen document per extension; no lifetime limit for
  `USER_MEDIA`.
- **Action — the activation gesture.** Clicking the action (or a keyboard command) is the
  activeTab-style *invocation* that MV3 hangs real capabilities on: script injection without host
  permissions, and — critically — picker-free `tabCapture` (§5). The action is also where the
  user opens the panel (`open()` needs a gesture) and forces takeover from a page-hosted overlay.

**Networking rule:** every socket/fetch to a channel goes through extension-page contexts (panel,
SW), never from content scripts. Extension contexts talk to `ws://127.0.0.1` freely (it's what the
entire extension-dev-tooling ecosystem is built on); content-script networking runs under the
page's rules, where Local Network Access (shipping progressively since Chrome 142) will
eventually gate LAN destinations. Routing everything through the panel sidesteps LNA and
mixed-content permanently.

## 2 · The per-window session model

Today one page = one peer of one channel. The extension flips this: **one browser window = one
intent session**, bound to one channel.

- The side panel is the binding point: the user picks a channel per window (discovery in §4);
  different windows can bind different channels (different projects at once).
- The engine's event log gains **tab provenance**: every event carries the tab it came from, and
  tab activation emits a **context-boundary event** — the generalization of the
  `navigation` event proposed in `spa-navigation-and-turn-continuity.md`
  (`{ kind: "navigation" | "tab-switch" | "split-change", from, to }`). Ordering in the log again
  gives attribution for free; lowering decides presentation (the defer-rendering rule).
- Arming, mode, and the transcript are window-level; the pill each content script renders is a
  *projection* of panel state over the Port, so switching tabs shows the same armed turn — the
  exact continuity the per-document model can't express.
- The session bus role for the panel is a new peer kind (`role: "window"`); tab stamps
  (`data-aiui-tab`) remain the correlation currency with the Chrome DevTools MCP
  (`session-browser` skill: extension tab ids are hints; MCP pageIds come from `list_pages`).

## 3 · Instrumented and plain pages: the degradation ladder

The extension works everywhere; instrumentation buys precision, never admission:

| Capability | aiui-instrumented page | plain page |
| --- | --- | --- |
| Text selection → turn | ✓ (with `sourceLoc`/cell attribution) | ✓ (text + URL only) |
| Ink, shots, share | ✓ | ✓ |
| Component locator in shots | ✓ (`data-source-loc`/`data-cell`) | rect only |
| Page tools (§7) | ✓ (`__AIUI__.tools`, WebMCP-flavored) | only if the page speaks WebMCP |
| Session bus / paint seams | ✓ | — |

The MAIN-world probe is the detector; `composeIntent` already degrades gracefully on missing
attribution. Plain-page intent ("this dashboard, but for our data") is a genuinely new
capability, not a degraded old one.

## 4 · Channel discovery: native messaging helper + direct sockets

Two-tier, matching what the helper is actually needed for:

- **Talking to a channel needs no helper.** Extension contexts dial `ws://127.0.0.1:<port>`
  directly, and one live channel enumerates the rest via `GET /debug/api/channels` (registry.ts
  mirrors the on-disk registry over HTTP precisely so "one reachable channel is enough"). The
  extension keeps a recent-ports list (the DevTools panel already does, `aiui.recentPorts`).
- **Cold start and process control need the helper.** The registry lives at
  `~/.cache/aiui/mcp/<pid>.json` — unreachable from an extension. A small **native messaging
  host** (`aiui` gains a `native-host` subcommand; a thin stdio shim in the KeePassXC-proxy
  style) answers `listChannels` by reusing `listMcpServers()` (liveness = `kill(pid, 0)`,
  directory-affinity sort — code that already exists), and can optionally spawn/adopt a channel.
  Registration manifests are written by `aiui extension install-native-host` into the
  **documented per-browser paths — including Chrome for Testing's own locations**
  (`~/Library/Application Support/Google/ChromeForTesting/NativeMessagingHosts/` on macOS), which
  matters because aiui prefers a managed CfT install. Framing limits (1 MB host→extension,
  64 MiB extension→host) are irrelevant at "list of channels" scale.
- **Remote channels: the VS Code pattern.** The helper (or the daemon behind it) owns the
  tunnel — `ssh -L <local>:127.0.0.1:<remote>` (or reads the remote registry over
  `ssh host aiui channel-list --json` first) — and the extension only ever talks to
  `127.0.0.1:<localport>`. No browser-side security machinery is ever aware the channel is
  remote. Nobody in this space tunnels inside the extension; everyone delegates to a native
  process (VS Code Remote, Chrome's own ADB port forwarding). This composes with the trusted-LAN
  posture: the tunnel is the user's explicit act, per remote.

## 5 · Capture: the extension makes it *better*, not just possible

The pivotal research finding: **invocation-gated `chrome.tabCapture` is picker-free by API
design** — "capture can only be started on the currently active tab after the extension has been
invoked, similar to the way that activeTab works." No dialog, no launch flags, no CDP marker.
Capture continues across tab switches and in-tab navigations, and stops on tab close. This
replaces the entire `--auto-accept-this-tab-capture` + `__AIUI_CAPTURE__` apparatus for tab-scoped
capture — and unlike that apparatus, it works in a personal Chrome. (The old
rejected idea — using an extension to carry the auto-capture *marker* — was rejected precisely
because the marker would travel into browsers where the promise is false; `tabCapture` carries no
such false promise.)

Concrete pipeline changes:

- **Shots**: frames grabbed in the offscreen document from the tabCapture stream (same
  hidden-`<video>` + canvas technique as today's `shot.ts`), *or* `tabs.captureVisibleTab` for
  cheap stills (activeTab suffices; hard limit 2 captures/sec). Component location stays in the
  page (the locator walks the DOM); rect + locator results travel over the Port and join the
  frame in the panel — the same marker/attachment protocol to the channel (`shot_N` chunks),
  unchanged server-side.
- **Ink compositing gets simpler.** The content script's ink canvas is part of the page DOM, so
  tabCapture *includes it natively* — the software `compositeInto` double-draw that the
  element-capture proposal flagged as a bug disappears for the extension path by construction.
- **Whole-window capture** (screen/window-shaped) still costs one picker per session from any
  extension context (`getDisplayMedia` has no extension privilege) — waivable only by launch-time
  test flags (`--auto-select-window-capture-source-by-title` et al.) that the session-browser
  launcher can add under the trusted-LAN posture. Budget: zero pickers in the session browser,
  one picker per window session in personal Chrome.
- **Element/Region Capture interplay — MEASURED (M1): does NOT carry over.** A tabCapture-derived
  track is a plain `MediaStreamTrack` (no `cropTo`/`restrictTo`) even when consumed inside the
  captured tab itself with the API globals demonstrably present; Chromium mints
  `BrowserCaptureMediaStreamTrack` only for `getDisplayMedia` self-capture. So picker-free
  extension capture is whole-tab frames only, and the capture-plane design in
  `element-capture-and-the-capture-plane.md` stays tied to `getDisplayMedia` (auto-accept flags
  in the session browser; one picker per session in personal Chrome). Hybrid accordingly:
  tabCapture for continuity/share/iPad + software rect-cropping for shots + `restrictTo` as a
  session-browser-only enhancement. Two more measured constraints: **one active tabCapture
  stream per tab** ("Cannot capture a tab with an active stream"), and unconstrained tab tracks
  default to display-sized `crop-and-scale` output — always pass width/height constraints.
  **The panel-first UI largely neutralizes this loss**: with all tool chrome in the side panel
  (which tab-scoped captures cannot see — measured) and only ink left in-page, there is almost
  nothing to occlude-remove; ink in frames is deliberate deixis. The element-capture plane
  remains relevant to the *web* overlay path, not the extension.

## 6 · The iPad, and split view

Today the iPad mirrors *the page's own* tab-capture stream (WebRTC track or 8 fps JPEG fallback
from the same grant the shots use). Under a per-window session the natural semantics change:
**the iPad is a view of the window's session**, not of one page. Options, in preference order:

1. **Follow the active tab**: the offscreen document holds the window's current tabCapture stream
   and re-points the paint host's `FrameSource` on tab activation. The iPad sees whatever tab the
   user is on — matching the mental model "the iPad shows what I'm working on."
   **Measured (M4):** previously-invoked tabs re-capture fine while backgrounded, streams stay
   pinned to their tab across focus changes, two concurrent captures work, and the per-tab grant
   is browser-state durable across SW restarts (~an hour verified) until navigation/tab close —
   so the only friction is one action click per *first* visit to a tab (softenable with a
   keyboard `commands` shortcut).
2. **Window capture**: one `desktopCapture`/`getDisplayMedia` window stream per session (one
   picker; zero in the session browser). The iPad sees the window — including browser chrome and,
   notably, **both panes of a split view**.
3. **Page-hosted capture** (status quo) as the fallback on instrumented pages when the extension
   isn't present.

**Split view** (stable since Chrome 143, broad in 145): extensions get *detection* —
`Tab.splitViewId`, `tabs.query({splitViewId})`, `onUpdated` changes. The capture semantics were
documented nowhere; **measurement M2 (live, CfT 150) settled the matrix**: `splitViewId` is real
and shared by the panes; `captureVisibleTab` returns the **active pane only**; tabCapture is
**pane-scoped** (each stream shows exactly its own tab — no chrome, no other pane); window
`getDisplayMedia` shows **everything** (both panes + side panel + chrome). So:

- **Recording both tabs**: two concurrent pane-scoped tabCaptures (concurrency proven under M4c,
  `getCapturedTabs()` reports both active) or the one window stream. The transcript's
  context-boundary events (`split-change`) mark when the visual context doubled.
- **iPad in split view**: option 2 (window capture) shows both panes naturally; option 1 shows
  the active pane and flips with `onActivated`. Both are coherent and both are now known to
  work; choosing is pure UX.

## 7 · Page tools: detection, tab changes, and notifying the agent

The current machinery (facts): pages declare whole tool sets per namespace on
`window.__AIUI__.tools`; the bridge ships schemas (content-hashed) over `ws://…/tools`; the
channel's `PageToolDirectory` keys registrations by (connection, ns), forgets them on socket
close, and exposes them to the agent through a **deliberately static** MCP meta-surface —
`page_tools_list` / `page_tools_call`, with ambiguity errors when two tabs offer the same tool.
The channel emits **no MCP notifications for tools** (`tools: {}` — no `listChanged`), so the
agent polls.

Extension design:

- **Detection.** On instrumented pages, the MAIN-world probe observes `__AIUI__.tools`
  registrations (and re-registrations — the hash discipline is already there) and relays them
  through the panel's `/tools` socket, tagged with tab identity. On plain pages, the probe
  detects **W3C WebMCP** (`navigator.modelContext`, draft CG report Feb 2026, early preview in
  Chrome 146 Canary) — the standards-track convergence target that `agent-tools.ts` already
  styles itself after. One directory, two dialects.
- **Tab changes update the directory.** The SW's tab lifecycle events drive `activation` updates
  on the same socket: the directory entries gain an `activeTab` flag (and lose entries on tab
  close exactly as socket-close does today). `page_tools_list` grows an active-first view;
  `page_tools_call` resolves ambiguity by preferring the active tab (exactly MCP-B's routing
  rule: active tab first, else any tab holding the tool).
- **Notifying the agent — three rungs, weakest dependency first.**
  1. **Floor (works today, no client support needed):** keep the static meta-tools; the agent
     polls `page_tools_list` and the list is simply *better ordered and fresher*.
  2. **Channel push (works today):** the channel already owns an experimental notification path
     into the running session (`notifications/claude/channel` — the same mechanism that injects
     lowered prompts). A debounced, hash-gated "active tab changed; its tools: …" push rides it
     with zero MCP-client dependencies. This is the pragmatic implementation of "the MCP server
     can notify the agent."
  3. **`tools/list_changed` (measure first):** the spec-blessed route — declare
     `tools: { listChanged: true }`, call `sendToolListChanged()`, and mirror promoted page tools
     as real MCP tools. Evidence on Claude Code's client support is *conflicting and
     version-dependent* (documented no-handler as of v2.0.65; a meta-issue says refresh works at
     turn boundaries but fails mid-turn — and tab switches usually happen mid-turn). Also
     unmeasured: interaction with deferred tool loading (ToolSearch) and the prompt-cache cost of
     tool-list churn. Rung 3 is gated on measurement M3 and is an *optimization*, not the
     foundation.

## 8 · Ink across tabs

Per-tab, not per-window: each content script owns its tab's ink canvas, so strokes are physically
incapable of floating over the wrong page (the SPA proposal had to legislate this; the extension
gets it by construction). Policies:

- Strokes stay with their tab; switching away freezes fade (pause the clock while hidden — the
  user who flips back mid-turn finds their annotation, which is the "intelligent" behavior the
  per-document model couldn't offer). Stroke events in the log carry tab provenance; the
  tab-switch boundary event attributes them.
- A turn's *send* clears all tabs' ink (turn scope unchanged); tab close drops that tab's layer.
  (Clearing on Send should be configurable -- Also it may currently not be doing this)

- In-tab navigation keeps the SPA proposal's rule: clear on navigation, screenshots are the
  durable deixis.

## 9 · State, HMR, and the extension dev loop

Answering "will overlay edits be visible in the extension, and what has to happen for it to
reload?" — the tooling landscape settled favorably:

- **CRXJS (revived 2025; v2.7.x current) does true in-page Vite HMR for content scripts** — the
  only tool that does — including a SolidJS content-script-HMR guide. Editing overlay source
  hot-swaps modules inside the running tab, state preserved, no extension reload. Caveats:
  MAIN-world scripts and IIFE scripts skip the HMR loader (our MAIN-world probe is deliberately
  tiny and stable, so that's fine); CRXJS × SolidJS 2.0 beta × this monorepo's source-first
  workspace linking needs a smoke test (M5).
- **Extension pages (side panel, options, devtools panel) get plain Vite HMR** — they're ordinary
  Vite-served HTML entries in dev. The trace viewer and panel UI iterate like any web app.
- **Nobody hot-swaps the service worker** — SW/manifest edits mean a full extension reload
  (automated by the tooling). This is why the SW must hold no precious state.
- **The turn survives all of it** better than today: the engine lives in the panel document and
  mirrors to `chrome.storage.session`, so a content-script HMR, a tab reload, a navigation, or
  even an extension reload recovers the turn from a store no page lifecycle touches. The
  HMR-recovery machinery in `turn-store.ts` — built to survive exactly one hazard — generalizes
  into "the turn simply doesn't live in a page anymore."
- **Fallback pattern** if CRXJS disappoints (M5): a thin, stable loader content script that
  imports the overlay bundle from the local Vite dev server — hand-rolling the same trick, at
  the cost of dev/prod delivery divergence.
- Distribution stays **unpacked** (as the DevTools extension today), auto-loaded via
  `--load-extension` in CfT/Chromium; branded Chrome ≥ 137 ignores that flag (one manual install
  into the persistent profile). Store listing — with its `<all_urls>` review friction — is
  explicitly out of scope until the surface stabilizes.

## 10 · Coexistence with the web intent tool

Both overlays will exist in the same profile — deliberately. **Decided (2026-07-11): no
deference protocol.** The two tools simply coexist as independent peers: a tab served by
`aiui vite` may host the web overlay *and* be visible to the extension at the same time — two
connections from the same tab, two turn hosts, and the user chooses which one to drive (or
uninstalls/ignores the extension entirely). No detection, no stand-down hooks, no takeover
logic. This trades a little duplicated UI for a large drop in coordination complexity, and it
preserves the debuggability asymmetry as a *feature*: the page-hosted overlay stays the
reference implementation the agent can reach through the Chrome DevTools MCP (`evaluate` on a
listed page), while extension contexts (SW, panel, offscreen) remain separate CDP targets. When
something breaks in the extension path, reproduce it in the web overlay first if possible.
The only interplay to design for is capture: **one tabCapture stream per tab** (measured), so
the extension must surface a clear error if the page overlay already holds the tab's stream
(and vice versa — the page's `getDisplayMedia` grant is independent and unaffected).
- **Code sharing is the point, not an aspiration.** The engine, keymap, composeIntent, protocol
  codec, turn store, errors, debug-ui are already framework-free and host-agnostic; the widget is
  Solid in a shadow root either way. The refactor is extracting the host seam that
  `IntentToolContext` already sketches — the modality talks to "a thing that opens threads, shows
  status, owns selection" and never learns whether that thing is a Vite-mounted page host or a
  panel-backed extension host. The existing `aiui-devtools-extension` (tab stamping, panel,
  esbuild'd debug-ui) is absorbed into the new extension over time rather than maintained beside
  it; its tsc-no-bundler build gives way to the CRXJS build.
   
  Note From Nehal:  This is great, but now thies means there are two types of clients -- page-hosted overlay clients and extension-hosted clients.  THis should be marked and be surfaced in things like the vscode extension


## 11 · Security posture

Same philosophy as `docs/guide/warning.md`, new surface: the extension injects into
`<all_urls>` (dev tool, unpacked — review friction moot), holds tab-capture capability after
invocation, and bridges pages to local channel servers. Mitigations that fall out of the design:
all channel traffic originates from extension contexts (never page-controllable code); the
MAIN-world probe is read-only and treats page globals as hostile input; native-messaging
`allowed_origins` pins the extension id; remote access is tunnel-only (the extension never dials
a non-loopback address). The trusted-LAN iPad path is unchanged — the iPad talks to the channel's
`/paint` endpoints, not to the extension; only the frame *source* moves. Enterprise policies
(`runtime_blocked_hosts`) can silently disable content scripts on managed machines — a
documented failure mode, not a design input.

## 12 · Measurements

> **Status:** the spikes are implemented in `archive/extension-spikes/` (capture-probe extension,
> mcp-list-changed probe, crxjs-smoke scaffold), with results recorded in its `RESULTS.md`.
> Measured (2026-07-10, CfT 150, CLI 2.1.206): **M1 = NO** (crop/restrict does not attach to
> tabCapture tracks — capture plane stays gDM-only), **M2 = matrix settled** (visibleTab =
> active pane; tabCapture = pane-scoped; window gDM = both panes + chrome), **M3 = PASSED**
> (list_changed honored cross-turn AND mid-turn; silent-flip control shows no background
> polling), **M4 = as documented** (invocation required per tab even with `<all_urls>`; grants
> durable across SW restarts; two concurrent captures; one stream per tab), **M5 headless leg
> passed** (CRXJS 2.7 builds Solid 2.0-beta.15 + overlay-source imports into a loadable MV3
> dist). Remaining: M5 live HMR leg, M6 soak.

Standing rule (learned the hard way, recorded in project memory): **capture measurements must be
taken by hand in the real session browser** — an agent-spawned Chrome under test flags lies about
`getDisplayMedia`, and an unanswered picker poisons the process.

### Measure now — each unblocks a design decision

- **M1 — `restrictTo`/`cropTo` on a tabCapture-derived track.** Scratch extension: SW
  `getMediaStreamId` → offscreen `getUserMedia` → attempt
  `RestrictionTarget.fromElement`(in-page, posted) + `restrictTo`. *Decides:* whether the
  capture-plane design carries over picker-free (best-case capture story), or software scoping
  stays. Also test `CropTarget`/`RestrictionTarget` transport: they are structured-cloneable but
  not JSON — which channel (if any) moves one from a content script to the offscreen doc.
- **M2 — split-view capture matrix.** Chrome ≥ 145, two tabs split: for each of tabCapture,
  `captureVisibleTab`, `getDisplayMedia` window, `desktopCapture` window — record what surface
  and dimensions come back, and which pane counts as `active: true`. *Decides:* the recording and
  iPad answers in §6, and whether "both tabs" needs two captures or one window stream.
- **M3 — Claude Code × `tools/list_changed`.** Toy stdio MCP server (`listChanged: true`,
  `sendToolListChanged()` on a timer/trigger); observe: refresh at turn boundary? mid-turn?
  interaction with ToolSearch-deferred schemas; whether the TS SDK asserts the capability before
  sending. *Decides:* whether rung 3 in §7 exists, or the channel-push rung is the ceiling.
- **M4 — tabCapture invocation semantics.** (a) With `<all_urls>` host permissions, is
  invocation still required per tab? (b) Can a previously-invoked, now-background tab be captured
  via `getMediaStreamId({targetTabId})`? (c) Two concurrent video captures in one extension?
  (d) Does the capture badge/indicator behavior differ per path? *Decides:* whether
  "iPad follows the active tab" is seamless or needs one click per new tab, and split-view
  dual-recording feasibility.
- **M5 — CRXJS smoke test on this stack.** Scaffold with Solid 2.0 beta + workspace-linked
  overlay source + current Vite; verify content-script in-page HMR, shadow-root UI, MAIN-world
  probe emission, panel HMR. *Decides:* the dev-loop foundation (CRXJS vs loader-from-dev-server
  fallback), before any extension code is written in earnest.
- **M6 — side-panel document lifetime.** Panel holding a websocket + fake engine: leave hidden
  hours, memory pressure, window minimize, `onOpened`/`onClosed` edges across window creation.
  *Decides:* whether the panel alone hosts the turn or `chrome.storage.session` mirroring must be
  aggressive (write-per-event, as `turn-store.ts` does today).

### Better deferred — real questions, no current decision hangs on them

- **LNA (Chrome ~147+) treatment of content-script `ws://` to loopback vs LAN** — the design
  routes networking through extension contexts, so this only matters if that rule is ever
  relaxed.
- **`getDisplayMedia` inside an offscreen document** (documented `DISPLAY_MEDIA` reason, field
  reports of focus quirks) — only needed if window capture must be initiated without a visible
  extension page; the panel can host the call.
- **WebRTC (`RTCPeerConnection`) from the offscreen document to the iPad** — expected to work;
  the JPEG-frame fallback trivially works, so this is a performance question, not viability.
- **Native-messaging manifest quirks across Edge/Chromium/CfT on Linux/Windows** — matters at
  distribution time; macOS + CfT paths are documented and enough for the first spike.
- **WebMCP (`navigator.modelContext`) detection** — track Chrome 146+ preview; the `__AIUI__`
  dialect is sufficient for every current consumer.
- **Prompt-cache/token cost of dynamic per-tab tool mirroring** (rung 3) — moot until M3 says
  rung 3 exists.
- **Store packaging / review** — out of scope until the surface stabilizes (same stance as the
  DevTools extension today).

## 13 · Sequencing

1. **Spikes M1–M6** (a scratch extension covers M1/M2/M4/M6 together; M3 is a toy MCP server;
   M5 is a scaffold).
2. **Host-seam extraction** in `aiui-dev-overlay`: engine/modality vs page-host split along
   `IntentToolContext` — a refactor that benefits the web tool immediately (it is also the SPA
   proposal's "turn outlives the document" enabler) and is the precondition for sharing.
3. **Extension package** (CRXJS or fallback per M5): panel + content script + SW + offscreen;
   channel binding per window; text/selection/ink/shots on the tabCapture path; static
   meta-tools + activation updates (§7 rungs 1–2).
4. **Native helper** (`aiui native-host` + manifest installer): local discovery first; tunnels
   second.
5. **iPad re-pointing + split-view behavior** per M2/M4 outcomes.
6. **Absorb `aiui-devtools-extension`** (tab stamping, panel) once the new extension is the
   daily driver.

## 13.5 · Panel interaction grammar (decided 2026-07-11, during step 4)

Three decisions from live use, diverging deliberately from the web overlay's grammar while
sharing its machinery:

- **Selection is explicit, never ambient (pull model).** Selecting page text does nothing to
  the turn. The user's "add selection" command (panel button; later a keystroke) pulls the
  active tab's current snapshot and appends it — or stages it as the next turn's opener when no
  thread is open. The content-script watcher only keeps the snapshot warm and pings presence
  for the affordance dot. Rationale: the user decides what enters the prompt and when; and a
  pull is loudly debuggable where the ambient push failed silently.
- **Armed carries no mode.** Armed = "this window's tool is live" (indicator ring), nothing
  more. Modes (ink, shot, talk) are each explicitly entered from the armed state; the overlay's
  armed→ink default is a page-overlay convention that does not carry over.
- **Keyboard is leader-key modal.** Page keys belong to the page; a leader chord opens aiui's
  key layer, then single keys pick actions/modes (I → ink, a slurp key, Esc leaves). Built on
  the same keymap/modal-kit machinery as the overlay — shared code, different grammar. Open:
  the leader itself, and whether Chrome `commands` global shortcuts host it.

## 14 · Open questions

- Does the per-window session bind to **one channel exclusively**, or can a window observe
  several channels with one *active* for turn-hosting? (Registry hop makes multi-channel cheap;
  the UX may not want it.)
- ~~Where does the widget pill live long-term?~~ **Decided (2026-07-11): panel-first.** The side
  panel is the tool's whole visible surface (command bar, preview, config, trace viewer,
  submodes); the page keeps only ink + selection + keymap relay, plus a **minimal in-page
  armed/mode indicator** (decided 2026-07-11: wanted — a border tint/cursor, since the panel
  may be closed while armed; it also lands in captures as a truthful "tool was armed" marker).
- Should the **web intent tool** eventually *detect* the extension and defer in the opposite
  direction (extension wins when both present), once the extension is mature? The §10 precedence
  is explicitly a bootstrapping order, not a final answer.
- Is a **turn transferable between windows** (drag a session to another window)? The per-window
  model makes it well-defined but nothing yet demands it.
- Firefox: `sidebarAction`, WebExtension NM, and its own split-view/`splitViewId` plans exist —
  worth keeping the host seam browser-agnostic, but nothing more yet.

## 15 · Key sources

Capture: developer.chrome.com — extensions tabCapture / offscreen / screen-capture how-to,
web-platform element-capture & region-capture; chrome_switches.cc (auto-select/auto-accept test
flags); chromeenterprise.google/policies (ScreenCapture*, MultiScreenCaptureAllowedForUrls —
ChromeOS/IWA-only). Split view: developer.chrome.com tabs API (`splitViewId`, Chrome 140+);
w3c/webextensions#967, #842. Tools/MCP: modelcontextprotocol.io spec 2025-06-18 (tools
listChanged); anthropics/claude-code issues #13646, #4118, #31893 (client support, conflicting);
MCP-B/WebMCP (github.com/WebMCP-org, mcp-b.ai — per-tab prefixes, active-tab routing);
webmachinelearning/webmcp (W3C draft, Feb 2026; Chrome 146 Canary preview); Chrome DevTools MCP
(static tools + page selection; `--experimentalPageIdRouting`). Tooling: crxjs.dev (v2 revival
2025, content-script HMR, Solid guide); wxt.dev (compare/FAQ — page-reload granularity);
plasmo (maintenance mode). Platform: developer.chrome.com sidePanel API + launch blog;
native-messaging doc (CfT manifest paths; 1 MB / 64 MiB limits); websockets-in-service-workers
(Chrome 116 idle-timer reset); Local Network Access blog + chromestatus (Chrome 142 launch);
KeePassXC-proxy, VS Code Remote/Tunnels docs (native-helper and tunnel prior art). Repo:
`docs/guide/screen-capture.md`, `docs/guide/devtools.md`, `docs/guide/chrome.md`,
`packages/aiui-devtools-extension/docs/tab-identity.md`,
`docs/proposals/element-capture-and-the-capture-plane.md`,
`docs/proposals/spa-navigation-and-turn-continuity.md`.
