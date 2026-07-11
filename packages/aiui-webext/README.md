# @habemus-papadum/aiui-webext

Shared infrastructure for building aiui Chrome extensions — written as if more than one will
exist. Two entry points:

- **`.`** (browser runtime): `serveRelay`/`relayRequest` (typed request/response over
  `chrome.runtime` messaging, addressed envelopes, errors marshalled as rejections),
  `PaneStack`/`Pane` (collapsible side-panel sections that keep children mounted while
  collapsed), `mountIndicator` (the minimal in-page armed-ring/dot — the only thing an aiui
  extension puts into a page), `ensureOffscreenDocument` (single-flight offscreen guard).
- **`./vite`** (build-time): `webextConfig({ manifest, devPort })` — CRXJS + Solid with the
  kit's conventions (pinned strict dev port, `server.fs.allow` for workspace source imports),
  and a re-exported `defineManifest`. The docblock in `src/vite.ts` records the dev-loop
  gotchas measured in `archive/extension-spikes/`.

First consumer: [`@habemus-papadum/aiui-extension`](../aiui-extension/README.md). Design
context: `docs/proposals/browser-extension-intent-tool.md`.
