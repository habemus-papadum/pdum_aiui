# @habemus-papadum/aiui-devtools-extension

A Chrome DevTools panel for debugging the aiui infrastructure. Published to npm with the
**built** extension inside (`extension/`, including its compiled `js/`), so `aiui` installed as a
dependency can auto-load it — into the browser it is always loaded unpacked (there's no store
listing). Design doc: the repo's *DevTools Panel* guide page.

Three views over two data sources:

| Tab | Shows | Source |
| --- | ----- | ------ |
| **Server** | The channel server's identity (tag, port, pid, owning Claude session), how the launcher wired the session (Chrome DevTools MCP on/off, attach endpoint or lazy launch, browser + profile — the connectivity-debugging view), health-ping latency, and server-side transport counters (connections, frames, bytes, per-frame processing time). | `GET /debug/api/info`, `/debug/api/stats` on the channel server |
| **Transport** | The *page's* view of the websocket: per-frame sizes and ack round-trip latency, with avg/p50/p95. | `window.__AIUI__` instrumentation recorded by `aiui-dev-overlay`, read via `chrome.devtools.inspectedWindow` |
| **Traces** | The prompt-lowering trace debugger (inputs → IRs → lowered prompt). | The server's `/debug` page, embedded (still usable standalone) |

Beyond the panel, the extension **stamps tab identity onto dev pages** (localhost /
127.0.0.1): whenever such a tab finishes loading, the background worker assembles the tab's ids —
`chrome.tabs` id/window/index plus the CDP target id from `chrome.debugger.getTargets()` (no
attach, so it never disturbs another debugger) — and injects a one-liner that writes them to
`data-aiui-tab` on `<html>`. The intent tool ships that stamp with every submission, which is how
a lowered prompt can tell the agent *which browser tab* it came from (see the repo's *Web Intent
Tool* guide and the `session-browser` skill). Internals — the mechanism, why it injects from the
background rather than using a content script, and the permission/debugging gotchas — are in this
package's **Tab Identity** guide (`docs/tab-identity.md`).

## Install (unpacked)

```sh
pnpm --filter @habemus-papadum/aiui-devtools-extension build   # tsc → extension/js
```

Then Chrome → `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select
`packages/aiui-devtools-extension/extension`. Open DevTools on a page running the intent tool and pick the
**aiui** tab.

The **session browser** (the shared Chrome that `aiui claude` or `aiui browser` starts) rebuilds
this extension in a dev checkout every time the browser starts (~0.3 s of tsc — never stale;
disable with `chrome.buildExtension: false` in config) and gets it auto-loaded
(`--load-extension`) where the browser honors that flag — Chromium and Chrome for Testing do,
Chrome-branded builds ≥ 137 ignore it. Where it's ignored, do the unpacked install above once in
*that* browser (`aiui chrome extension` prints the directory); its profile
(`.aiui-cache/chrome/<profile>`) keeps it across sessions.

The panel discovers the channel port from the inspected page (`window.__AIUI__.port`, published
when the intent tool mounts). No instrumented page? A manual port field appears — and the panel
also works opened as a plain tab (`panel.html?port=<port>`), minus the page-side Transport
metrics.

## Notes

- `extension/js/` is build output (gitignored); `manifest.json` and the HTML shells are source.
- The extension's `manifest.json` version is independent of the workspace's lockstep version
  (Chrome requires plain dotted integers).
