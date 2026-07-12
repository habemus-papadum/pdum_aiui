# @habemus-papadum/aiui-webext

Shared infrastructure for building aiui Chrome extensions — written as if more than one will
exist. Two entry points:

- **`.`** (browser runtime): `serveRelay`/`relayRequest` (typed request/response over
  `chrome.runtime` messaging, addressed envelopes, errors marshalled as rejections),
  `PaneStack`/`Pane` (collapsible side-panel sections that keep children mounted while
  collapsed), `mountIndicator` (the minimal in-page armed-ring/dot — the only thing an aiui
  extension puts into a page), `ensureOffscreenDocument` (single-flight offscreen guard),
  `checkDevBuild` (am I stale? is my dev server up? — the fact every extension surface needs
  before it decides to render nothing).
- **`./vite`** (build-time): `webextConfig({ manifest, devPort })` — CRXJS + Solid with the
  kit's conventions (pinned strict dev port, `server.fs.allow` for workspace source imports),
  and a re-exported `defineManifest`. The docblock in `src/vite.ts` records the dev-loop
  gotchas measured in `archive/extension-spikes/`.

**The dev artifact is not the release artifact.** `vite` writes `dist-dev/` (CRXJS loader stubs,
useless without the dev server) and `vite build` writes `dist/` (standalone, what ships) — so a
build can never clobber a live dev install, and neither can pretend to be the other. The dev build
also stamps itself complete when it finishes writing (`dist-dev/aiui-dev.json`, serving the same
`runId` at `/@aiui/dev-run`): that stamp is what lets `aiui extension dev` reload Chrome at the
right moment, and what `checkDevBuild` compares to tell "fresh" from "stale" from "server down".
Full story: `src/dev-stamp.ts`.

First consumer: [`@habemus-papadum/aiui-extension`](../aiui-extension/README.md). Design
context: `docs/proposals/browser-extension-intent-tool.md`.
