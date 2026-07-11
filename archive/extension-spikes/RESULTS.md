# extension-spikes — results ledger

Environment for all entries unless noted: macOS (Darwin 25.5.0), Claude Code CLI 2.1.206,
Node 24.4.0, July 10 2026.

## M3 — Claude Code × `notifications/tools/list_changed` · **MEASURED (headless-appropriate)**

Probe: `mcp-list-changed/` (dependency-free stdio server, real `claude` CLI spawns, JSONL wire
logs). Model: haiku. Protocol-level measurement — headless is the honest environment here.

- **Run A (notify on, two turns, one process):** client sent `tools/list` once at connect;
  after the flip the server emitted `list_changed` and the client re-fetched `tools/list`
  **3 ms later** (18:24:35.586 notification → 18:24:35.589 list). In turn 2 the model called
  `probe_beta` successfully. **Cross-turn dynamic tools work on 2.1.206.**
- **Run B (fresh process, pre-flipped):** sees both tools. Sanity ✓.
- **Run C (silent flip, no notification):** client NEVER re-listed; turn 2 reported
  "BETA NOT AVAILABLE" and no `tools/call probe_beta` reached the server. **The notification is
  both necessary and sufficient (this version); there is no background polling.**
- **ToolSearch interaction:** deferred tool loading was active — the model used ToolSearch before
  each MCP call, and after `list_changed` ToolSearch surfaced the *new* tool. The
  refresh-under-deferral path works.
- **Run D (mid-turn):** one turn calls alpha, then beta. Notification landed mid-turn
  (18:27:32.612), client re-listed **5 ms** later, and `probe_beta` was called successfully
  **in the same turn** (the model issued a second ToolSearch, which surfaced the fresh tool).
  Mid-turn adoption WORKS on 2.1.206 — better than the 2025 GitHub-issue folklore (#31893
  "fails within the same turn"); plausibly ToolSearch's deferred loading is what makes the
  mid-turn path work, since the tool is looked up at use time rather than pinned at turn start.
- **Model-behavior nuance (second pass, run B):** the wire log proved the server returned both
  tools at connect, yet haiku answered "BETA NOT AVAILABLE" without ToolSearching (the first
  pass's run B called it fine). Protocol ≠ usage: with deferred loading, a tool being *listed*
  doesn't guarantee a weak model *finds* it. Notification design should pair pushes with a hint
  the model can act on (the channel-push rung does this naturally by naming the new tools).

**Design consequence for the proposal (§7):** rung 3 (`tools.listChanged: true` +
`sendToolListChanged()`) is viable on current Claude Code — cross-turn AND mid-turn — not just
the channel-push rung. Version-sensitivity remains (older issues reported no handler): treat the
channel-push rung as the floor, `list_changed` as the default enhancement, and keep run-m3 as a
cheap regression probe against new CLI versions.

## M5 — CRXJS × SolidJS 2.0 beta × overlay source · **headless leg PASSED, live leg pending**

Probe: `crxjs-smoke/`. `@crxjs/vite-plugin` 2.7.1 + Vite 6.4.3 + `vite-plugin-solid
3.0.0-next.5` + `solid-js`/`@solidjs/web` 2.0.0-beta.15 (repo's exact pins) + an import of
`packages/aiui-dev-overlay/src/errors.ts` (overlay *source*, outside the project root).

- `vite build` **succeeds** (7 modules, 150 ms) and emits a loadable MV3 `dist/` — manifest
  rewritten correctly (content script → hashed asset + `web_accessible_resources`).
- Gotcha found: Solid 2.0 beta has **no `solid-js/web`** export — `render` comes from
  `@solidjs/web` (as the overlay's own `widget.tsx` does). npm also needs the `@solidjs/web`
  pin to matched betas (peer of `vite-plugin-solid` floats to beta.17 otherwise and conflicts).
- **Live leg (in-page HMR fidelity, state preservation, cross-package edits) still to run** —
  see crxjs-smoke/README.md; result to be recorded here.

## M1 / M2 / M4 / M6 — capture probes · **live testing in progress**

Probe: `capture-probe/` (plain-JS MV3, load unpacked). Human-driven in the real session browser
(CfT 150.0.7871.46).

- **M4a — MEASURED (live, session browser):** `getMediaStreamId({targetTabId})` from the SW with
  `<all_urls>` host permissions but **no prior action click** fails:
  `"Extension has not been invoked for the current page (see activeTab permission). Chrome pages
  cannot be captured."` Host permissions do NOT relax tabCapture's invocation gate. Also
  confirmed in the same error string: `chrome://` pages are never capturable.
- Operational note for future probes: an extension without a `default_icon` hides behind the
  puzzle-piece menu — pin it to get a clickable action; each click = one invocation of the
  focused tab (the SW logs `INVOKED on tab …`).
- **Invocation works as documented (live):** action click on the Google tab → `INVOKED … —
  activeTab granted`, after which `getMediaStreamId({targetTabId})` + offscreen `getUserMedia`
  succeeded — stream report `settings 5120x1440@30fps` with a correct snapshot. Picker-free, no
  dialog, only the tab-strip capture indicator.
- **M4b (background capture of a previously-invoked tab) — PASSED (live):** capture kept running
  and re-snapshotting the Google tab while other tabs were focused; the stream is pinned to its
  tab (it never follows focus). This is the continuity property the per-window design wants.
  Invocation is strictly per-tab: capturing a second tab requires an action click on THAT tab
  first.
- **M4c (two concurrent video captures) — PASSED (live):** second tab invoked + captured while
  the first stream ran; `snapshot all` returned correct stills of BOTH tabs and
  `getCapturedTabs()` reported both as `{"status":"active"}`
  (`[{tabId:1015960432},{tabId:1015960433}]`). No "Busy" error — the 2012 design doc's reserved
  concurrency cap is not enforced at 2 streams on CfT 150.
- **M4 verdict:** invocation-gated but otherwise ideal for the per-window design — per-tab
  invocation is the only friction ("iPad follows active tab" costs one action click per
  first visit to a tab; a keyboard `commands` shortcut can soften it).
- **One stream per tab (live):** starting an in-page capture while the offscreen doc already
  held a stream of the same tab failed with `"Cannot capture a tab with an active stream."`
  A tab supports exactly one active tabCapture stream — the extension cannot hold a share
  stream and also hand the page its own stream for the same tab.

### M1 — cropTo/restrictTo on tabCapture-derived tracks · **MEASURED: NO (live, CfT 150)**

The decisive leg: `getMediaStreamId({targetTabId, consumerTabId})` consumed **in the captured
tab itself** (no transport problem possible). Result:

- `trackConstructor: "MediaStreamTrack"` — NOT `BrowserCaptureMediaStreamTrack`;
  `hasCropTo`/`hasRestrictTo` both `undefined`.
- Control facts in the same context: `globalCropTarget`/`globalRestrictionTarget` are
  `"function"` — the Region/Element Capture API exists in that world; the tabCapture track is
  simply not the track type that carries them. Chromium mints `BrowserCaptureMediaStreamTrack`
  only for `getDisplayMedia` self-capture.
- Wrinkle: the unconstrained tab track defaulted to 5120x1440 `crop-and-scale`
  (`screenPixelRatio 1.25`) for an 814-CSS-px page — always pass width/height constraints.

**Design consequence:** picker-free extension capture (tabCapture) = whole-tab frames only; the
element-capture proposal's occluder-free capture plane stays tied to `getDisplayMedia`
self-capture (auto-accept flags in the session browser; one picker/session in personal Chrome).
Hybrid: tabCapture for continuity/share/iPad + software rect-cropping for shots + `restrictTo`
as a session-browser-only enhancement.

- **Durable invocation grant (live, incidental):** a capture succeeded with the SW logging
  `invoked at: NEVER` — the MV3 service worker had restarted (in-memory invocation ledger
  wiped) while Chrome's activeTab grant, given ~an hour earlier, still authorized capture.
  Per-tab invocation is browser-state, durable until navigation/tab close, independent of
  extension process lifetime. (Alternative reading — split panes sharing invocation — not
  excluded by this log, but the SW-restart explanation fits all facts.)

### M2 — split-view capture matrix · **MEASURED (live, CfT 150)**

Two tabs (NPR | Google) in one split view, extension side panel open:

| Primitive | What it returned |
| --- | --- |
| `Tab.splitViewId` | real; both panes share one view id (panel dropdown showed it) |
| `captureVisibleTab` | **active pane only** — never both |
| tabCapture per pane | **pane-scoped**: #4 showed only NPR, #5 only Google; no chrome, no other pane |
| `getDisplayMedia` (window, from panel) | **everything**: both panes + side panel + chrome (`surface: window`, 1200x1276) |

**Design consequences:** "record both split tabs" = two concurrent tabCaptures (proven under
M4c) or one window gDM; "iPad shows both panes" = the window-capture option; per-pane capture
composes cleanly with the per-window session model. Reminder from both M1/M2 runs: default
(unconstrained) tab tracks come back 5120x1440 `crop-and-scale` regardless of surface shape —
real code must set width/height constraints.

### M6 — side-panel document lifetime · **PASSED (live soak)**

Panel left open across hours of live testing (including overnight into 2026-07-11): `lifetime
report` shows **no heartbeat gaps**. The panel document is a stable host for sockets and engine
state; `chrome.storage.session` mirroring can stay lazy rather than paranoid.

### M5 live HMR leg — first attempt invalidated; pipeline verified server-side

The first live run "failed" for reasons that had nothing to do with CRXJS, reconstructed from
port listeners and dist mtimes:

1. The pinned port 5199 was **already held by an unrelated dev server from another checkout**
   (`pdum_aiui-review-pr1/packages/aiui-code`, running since Jul 7 with `--strictPort 5199`), so
   `npm run dev` refused to start.
2. The retry `vite 45555` passed the port as a **positional arg = root directory** — that server
   ran with the wrong root, never loaded our config (hence the mystery port 5179, 5173 bumped),
   and had no CRXJS pipeline.
3. The extension actually loaded in Chrome was the **stale production dist** from the headless
   build — static bundle, HMR structurally impossible, dev server silent by construction.

Fix: pin moved to 5311. With the dev server started correctly, CRXJS rewrote `dist/` into the
dev shape (`src/content.tsx-loader.js` + its own service worker + vendor) and the watcher fires
(`hmr update /src/content.tsx` logged on edit). Lesson for the run-book: after switching between
`build` and `dev`, always Reload the unpacked extension — the two dist shapes are entirely
different artifacts at the same path.

**Final verdict (2026-07-11, live, real extension): PASSED.** The M5 live leg was re-run on the
actual `packages/aiui-extension` (step-1 checkpoint of the implementation plan, CRXJS dev mode,
port 5317): editing the content script's badge updated the in-page indicator **in place, with
the click counter preserved and no page reload** — true content-script HMR with SolidJS
2.0-beta.15 in the workspace. (Counter state rides a `window` stash: it survives hot swaps by
design and resets on document reload, as expected.) Panel pages get plain Vite HMR.

Optional remaining: personal-Chrome contrast run (expected identical for tabCapture — no flags
involved; picker for gDM).
