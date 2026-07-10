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
- M4c (two concurrent captures), M1 in-page crop/restrict, M2 split-view matrix, M6 soak:
  pending below.
