# The DevTools Panel

Debugging the aiui infrastructure is itself a DevTools problem, so the debugging surface lives
where frontend debugging already lives: an **aiui panel in Chrome DevTools**
(`@habemus-papadum/aiui-devtools-extension`, a Manifest-V3 extension loaded unpacked). It is the home for
both kinds of debugging the system needs:

- **High-level monitors** that watch the plumbing regardless of modality — the MCP/channel server
  itself and its transport counters.
- **Transport/format-specific tools** — today the prompt-lowering trace debugger; later,
  per-modality views (waveforms for audio, region overlays for screenshots).

## Design: one data source, two views

The panel is a *viewer*; the truth lives in **the channel server** (HTTP, loopback):

- Its own identity at `/debug/api/info` (tag, port, pid, owning Claude session — the same payload
  as the `channel_info` MCP tool) plus, under `launch`, the **launch info** `aiui claude` handed
  it: whether the session has a [Chrome DevTools MCP](./chrome), attach or launch, which
  endpoint/browser/profile, whether the panel was auto-loaded. The Server tab renders it, making
  the panel the first place to look when the agent's browser tooling misbehaves.
- Server-side transport counters at `/debug/api/stats` (connections, frames in, bytes in,
  per-frame processing time).
- The lowering traces under `/debug/api/traces`, and the revision poll at
  `/debug/api/traces/:id/live`.

The **inspected page** contributes one thing: the channel port. `aiui-dev-overlay` publishes it on
`window.__AIUI__` when the intent tool mounts, and the panel reads it out through
`chrome.devtools.inspectedWindow` — so the panel auto-discovers which local server to talk to. No
instrumented page? A manual port field appears, and the panel works opened as a plain browser tab
(`panel.html?port=<port>`); the server-backed views are CORS-readable on loopback, so nothing is
lost.

### Server — the high-level monitor

Channel identity (tag, port, pid, cwd, owning session), a live ping latency in the header, and
the server's transport counters with the recent-frame log (server processing time per frame):

![The aiui panel's Server tab](/devtools-server.png)

### Traces — the lowering debugger

Pick a trace and the pane **follows it live**: the multimodal intent event stream, the recomputed
IR passes (timeline → transcript + corrections → lowered prompt with token→path meta), and
per-segment timing. It is a one-second poll of `/debug/api/traces/:id/live`, which answers
`{unchanged:true}` when nothing moved (the revision is the manifest's mtime), so following a
running lowering is a trickle of bytes rather than an open socket.

The rendering is the same shared `debug-ui` every other home uses (the `/__aiui/debug` page,
`aiui debug`), so trace debugging looks identical wherever you do it. Any trace renders —
text-concat generically, `intent-v1` with the rich event view. Trace lists mark provenance: a
trace whose hello carried a non-human `actor` (browser automation self-reports as `agent`) is
badged, so agent-driven UI-testing turns are tellable from yours. The picker defaults to the
current server's session; an **all sessions** checkbox reveals earlier and other runs.

If the launcher's OpenAI-key preflight reported a non-`valid` status (surfaced under
`/debug/api/info` → `launch.openaiKey`, a *status* only — never the key), the pane shows one line
explaining that transcription and correction are unavailable until the key is set or fixed.

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
