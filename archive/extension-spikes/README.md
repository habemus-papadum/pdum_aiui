# extension-spikes — measurements for the browser-extension intent tool

Scratch measurement code for the spikes named in
`docs/proposals/browser-extension-intent-tool.md` §12. Nothing here is product code; nothing
outside this folder depends on it. Results are recorded in `RESULTS.md` next to this file as the
spikes run, and the durable conclusions get folded back into the proposal.

**Live-measurement rule (project memory, learned the hard way):** capture behavior measured in a
headless/agent-driven Chrome does not transfer. Every `getDisplayMedia`/picker/tabCapture leg
below must be exercised by a human hand in the real session browser (or a personal Chrome, when
that's the variable). The M3 probe is protocol-level (stdio JSON-RPC), where headless is the
honest environment.

## Spikes

- `capture-probe/` — plain-JS MV3 extension, loaded unpacked. Covers:
  - **M1** — does `cropTo`/`restrictTo` exist on a tabCapture-derived track; can
    `CropTarget`/`RestrictionTarget` move between contexts; the in-page consumption path
    (`getMediaStreamId({consumerTabId})` + same-tab minting) that would sidestep transport
    entirely.
  - **M2** — split-view capture matrix: what tabCapture, `captureVisibleTab`,
    panel `getDisplayMedia` (window), and `desktopCapture` each return for split panes
    (snapshots + dimensions logged in the side panel).
  - **M4** — tabCapture invocation semantics: capture without prior action-click (with
    `<all_urls>` host permissions), capture of a background/previously-invoked tab via
    `targetTabId`, two concurrent video captures, capture continuity across tab switches.
  - **M6** — side-panel document lifetime: a heartbeat to `chrome.storage.session`; the panel's
    "lifetime report" shows gaps (throttling/discard evidence).
- `mcp-list-changed/` — **M3**: a dependency-free stdio MCP server whose tool list changes
  mid-session (emitting `notifications/tools/list_changed`), plus a driver that runs a real
  `claude -p --input-format stream-json` multi-turn session against it. The JSONL wire log is
  ground truth for what the client actually did (re-fetched `tools/list`? when?).
- `crxjs-smoke/` — **M5**: CRXJS v2 + Vite 6 + `vite-plugin-solid 3.0.0-next.5` +
  `solid-js 2.0.0-beta.15` + an import of overlay *source* from `packages/aiui-dev-overlay/src`
  (the monorepo source-first convention). Headless leg: does `vite build` produce a loadable
  extension. Live leg: does content-script in-page HMR actually hot-swap with this stack.

## Running

Each subfolder has its own README with exact steps. The extension spikes are loaded unpacked via
`chrome://extensions` → Developer mode → Load unpacked (the session browser's persistent profile
keeps them installed). `crxjs-smoke` and `mcp-list-changed` are standalone npm/node projects —
deliberately **not** workspace members; install with `npm install` inside the folder.
