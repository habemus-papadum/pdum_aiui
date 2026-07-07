# The DevTools Panel

Debugging the aiui infrastructure is itself a DevTools problem, so the debugging surface lives
where frontend debugging already lives: an **aiui panel in Chrome DevTools**
(`@habemus-papadum/aiui-devtools-extension`, a Manifest-V3 extension loaded unpacked). It is the home for
both kinds of debugging the system needs:

- **High-level monitors** that watch the plumbing regardless of modality — the MCP/channel server
  itself, and the websocket transport (latency, sizes, throughput).
- **Transport/format-specific tools** — today the prompt-lowering trace debugger; later,
  per-modality views (waveforms for audio, region overlays for screenshots).

## Design: two data sources, three views

The panel is a *viewer*; the truth lives in two places, deliberately:

1. **The channel server** (HTTP, loopback): its own identity at `/debug/api/info` (tag, port,
   pid, owning Claude session — the same payload as the `channel_info` MCP tool) plus, under
   `launch`, the **launch info** `aiui claude` handed it — whether the session has a
   [Chrome DevTools MCP](./chrome), attach or launch, which endpoint/browser/profile, whether
   the panel was auto-loaded. The Server tab renders it, making the panel the first place to
   look when the agent's browser tooling misbehaves. Also server-side transport counters at
   `/debug/api/stats` (connections, frames in, bytes in, per-frame processing time), and the
   lowering traces under `/debug/api/traces`.
2. **The inspected page**: `aiui-dev-overlay` instruments its protocol client, recording every sent
   frame — size and **ack round-trip time as the page experienced it** — into a bounded
   `window.__AIUI__` ring. Only DevTools can read another page's globals
   (`chrome.devtools.inspectedWindow`), which is precisely why this data pulls the debugger into
   a DevTools panel: client-perceived latency exists nowhere else.

The same global carries the **channel port**, so the panel auto-discovers which local server to
talk to the moment an intent tool has mounted in the page. No instrumented page? A manual port
field appears, and the panel even works opened as a plain browser tab (minus the page-side
metrics — the server-backed views are CORS-readable on loopback).

### Server — the high-level monitor

Channel identity (tag, port, pid, cwd, owning session), a live ping latency in the header, and
the server's transport counters with the recent-frame log (server processing time per frame):

![The aiui panel's Server tab](/devtools-server.png)

### Transport — the websocket, as the page saw it

Frames sent, bytes on the wire, and ack round-trip latency (avg/p50/p95), plus the per-frame log —
kind, format, thread, size, rtt, outcome. This is where a sluggish modality shows its cause:
big frames, slow acks, or errors:

![The aiui panel's Transport tab](/devtools-transport.png)

### Traces — the lowering debugger

The [trace debugger](./web-intent-tool#the-debugger) — inputs → intermediate representations →
the lowered prompt — rendered by the same shared `debug-ui` panes every other home uses (the
`/__aiui/debug` page, `aiui debug`), over the channel's `/debug/api/*` JSON routes; the panel
embeds rather than reimplements it. Trace lists mark provenance: a trace whose hello carried a
non-human `actor` (browser automation self-reports as `agent`) is badged, so agent-driven
UI-testing turns are tellable from yours.

## Install & use

```sh
pnpm --filter @habemus-papadum/aiui-devtools-extension build   # tsc → extension/js
```

Chrome → `chrome://extensions` → **Developer mode** → **Load unpacked** →
`packages/aiui-devtools-extension/extension`. Then open DevTools on your app (e.g. the
[`pnpm demo`](./getting-started) playground) and pick the **aiui** tab.

In the [session browser](./chrome) — the shared Chrome that `aiui claude` or `aiui browser`
starts — a dev checkout rebuilds the extension automatically every time the browser starts
(~0.3 s of tsc, so it's never stale; `chrome.buildExtension: false` in [config](./config) skips
it) and auto-loads it via `--load-extension` where the browser honors that flag (Chromium, Chrome
for Testing; Chrome-branded builds ≥ 137 ignore it). Where ignored, load it unpacked once in that
browser — its user data dir (`.aiui-cache/chrome/<profile>`) persists, so the extension stays
installed across sessions. The manual `pnpm --filter` build above is only needed for loading into
your own personal browser.

When aiui is a **dependency of your project** rather than this repo, nothing changes except the
build step: the published `@habemus-papadum/aiui-devtools-extension` package ships the extension prebuilt,
and `aiui chrome extension` prints its path (use that for Load unpacked). See
[The Agent's Browser](./chrome#the-aiui-devtools-panel-when-is-it-available) for the full
availability matrix.

## Open questions

- **More monitors**: prompts/minute, per-format traffic split, trace-cache size, MCP notification
  failures — the counters exist server-side; the panel decides what earns pixels.
- **Custom per-modality views**: the trace manifest carries its format; how a modality registers
  a richer viewer (component? URL? iframe?) is still open — same question as in the
  [intent tool design](./web-intent-tool#open-questions).
- **Firefox**: the extension APIs used (`devtools.panels`, `inspectedWindow.eval`) have
  WebExtension equivalents; untested.
- **Packaging**: loaded unpacked for now; a store listing only makes sense once the surface
  stabilizes.
