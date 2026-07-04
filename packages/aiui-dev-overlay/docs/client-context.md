# Client Context: how an intent learns where it came from

Technical reference for the `meta` block the intent tool sends on every connection's
hello — the machinery that lets a lowered prompt tell the agent *which browser tab* the
intent came from and *where that page's source code lives*. The agent-facing half (how to
route to the tab with the Chrome DevTools MCP) is the `session-browser` skill; this page
is the plumbing.

## What is sent

When the widget opens a thread, `collectClientMeta()` (instrumentation.ts) assembles a
fresh snapshot and `connectIntentSocket` puts it on the hello envelope (wire shape: the
channel package's *WebSocket Protocol* doc):

```json
{
  "v": 1, "kind": "hello", "format": "text-concat",
  "meta": {
    "tab": {
      "url": "http://localhost:5199/",
      "title": "spectra — aiui demo app",
      "chromeTabId": 1694699257,
      "windowId": 1694699241,
      "tabIndex": 0,
      "targetId": "CB992081B105C12732530E12D8B3B267"
    },
    "source": { "root": "/Users/nehal/src/pdum_aiui/packages/aiui-demo" }
  }
}
```

## Where each field comes from

Three independent sources, each optional, merged at **send time** (so the snapshot is
current, not load-time stale):

| Field | Source | Mechanism |
| ----- | ------ | --------- |
| `tab.url`, `tab.title` | the page itself | live `location.href` / `document.title` |
| `tab.chromeTabId`, `windowId`, `tabIndex`, `targetId` | the **aiui DevTools extension** | read from the `data-aiui-tab` attribute on `<html>` — see the extension's *Tab Identity* doc for how it gets there |
| `source.root` | the **`aiuiDevOverlay()` Vite plugin** | seeded as `window.__AIUI__.sourceRoot` by the plugin's inline head script (default: the resolved Vite root; override with the plugin's `sourceRoot` option) |

Degradation is per-source and silent:

- **No extension** (or it hasn't stamped yet): `tab` carries only the live url/title.
  Malformed or mistyped stamp JSON is ignored field-by-field.
- **No plugin** (manual mount outside Vite): no `source` block.
- **No DOM** (SSR, tests without jsdom): `collectClientMeta()` returns `undefined` and
  the hello carries no `meta` at all.

A page is never blocked from sending by missing context.

## Why a DOM attribute, and why these ids

The page cannot know its own tab identity — no web API exposes it — and this package is
dependency-free browser code, so the extension delivers the ids through the one surface
both worlds share: the DOM. The extension writes `data-aiui-tab` (JSON) on
`document.documentElement`; `collectClientMeta` parses it defensively (each field
type-checked, the rest kept on a bad field).

The ids come from **three namespaces that must not be confused** — `chrome.tabs` ids,
the CDP target id, and the Chrome DevTools MCP's `pageId` (which only `list_pages` can
produce). The server-side prompt augmentation labels them as correlation hints for
exactly that reason. Background: `archive/chrome-devtools-mcp-tab-routing-notes.md` in
the repo.

## What the server does with it

The channel connection hands `meta` to every thread's processor
(`ThreadContext.hello`); tracing records it as an `info` stage on every trace; the
`text-concat` processor prefixes the lowered prompt with the tab block (plus a pointer
to the `session-browser` skill) and the source location, then the user's text. In the
`/debug` trace viewer a contextualized run shows four stages: `info` client context →
`input` frames → `ir` user text → `output` the full augmented prompt.

## Type mirroring

`TabInfo` / `ClientMeta` in instrumentation.ts are deliberate local mirrors of the
channel package's `TabInfo` / `HelloMeta` — this package re-implements the wire layer to
stay dependency-free (same policy as protocol.ts), and the tests cross-check the emitted
frames against the channel package's decoder. If you change one side, change both.
