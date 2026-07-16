# The aiui Claude channel — architecture

A map of the custom-channel MCP server: the components to keep in your head, how
its websockets scale, what the "proxies" are, the two run modes, and the
simplifications we've decided on. Written so the component list doesn't have to
be rediscovered from the source each time.

## What it is, in one sentence

One Node process, spawned by Claude Code, that speaks MCP over stdio **and**
runs a single HTTP+WebSocket server on one port — the seam between the running
Claude session and every frontend (browser tabs, the detached panel, an iPad).

## Components to keep

Grouped by role. Each line names the file(s) that own it.

### 1. The MCP core — the reason it's an "MCP server"
- **stdio transport + the one egress** (`commands/mcp.ts`): a
  `StdioServerTransport` on stdin/stdout, and the single push that matters —
  `notifications/claude/channel`, which injects a lowered prompt (or a
  page-tools / staleness note) into the session. Everything else exists to feed
  or observe this.
- **MCP tool surface** (`tools.ts`, `server.ts`): the static meta-tools plus
  `page_tools_list` / `page_tools_call` (drive page-declared tools) and
  `channel_reload` (manual reload).

### 2. The web backend — one server, one port
- **`startWebServer` (`web.ts`)**: the whole HTTP+WS backend. REST: `/health`,
  `/prompt`, `/debug/api/*`. Three channel-owned websockets in `noServer` mode,
  routed by one `upgrade` listener:
  - **`/ws`** — the stream-processor wire (the *main* intent channel: audio /
    shots / events / context frames → the lowering pipeline).
  - **`/tools`** — the page-tool directory feed.
  - **`/session`** — the session hub (presence / arming / iPad slots).
  Any upgrade it doesn't claim is offered to each sidecar, then destroyed.

### 3. The lowering / intent pipeline — the actual compiler
- **`intent-v1.ts` + `processors.ts` + the format registry** (`channel.ts`,
  `codec.ts`, `frame.ts`): frames in → a lowered, interleaved prompt out. This
  is the heart; the rest is plumbing around it. **This is the natural extraction
  candidate** (see "Compiler extraction" below).

### 4. Registry + discovery
- **`registry.ts`** — each channel writes a file (tag, pid, ppid, port, cwd,
  `debug?`). **`list.ts`** (`listMcpServers`, prunes dead entries).
  **`select.ts`** (`selectMcpServer`, the interactive picker). Discovery is
  "read the registry dir" — nothing more.

### 5. Session / tab description — three distinct things
- **`page-tools.ts`** (`/tools`): which tabs expose which tools; drives
  `tools/list_changed` + the page-tools push.
- **`session-hub.ts`** (`/session`): presence and arming across a session's tabs
  and the iPad.
- **`launch-info.ts`**: how *this* session was assembled (browser wiring),
  surfaced at `/debug/api/info`.

### 6. Observability
- **frame log** (`frame-log.ts`, `/debug/api/frames`): a bounded ring of every
  `/ws` message — parsed JSON for small text, **byte counts only** for binary
  (audio/PNG never enter the ring).
- **trace store** (`trace.ts`, `tracing.ts`, `.aiui-cache/`, `/debug/api`): the
  per-turn lowering record. The live `traceSink` seam narrates pipeline stages.

### 7. Sidecars — extra surfaces on the one port
- **contract** (`sidecar.ts`): `mount(app, ctx)` + optional `handleUpgrade` +
  `dispose` — the mount seam.
- **standard set** (`standard-sidecars.ts`): `standardSidecars(root)` imports
  and builds the four by ordinary import. This is the one place that names the
  implementations; `runMcp`/`runServe` default to it.
- The concrete four (each in its own package, now a real dependency): **paint**
  (`/paint/*`, iPad stream), **intent** (`/intent/*`, the detached panel + the
  CDP proxy), **bar** (`/bar/*`), **pencil** (`/pencil/*`, WebRTC signaling).

### 8. Upstream proxies — the "relays"
- **CDP proxy** (in the intent sidecar, `aiui-intent-client/src/cdp-proxy.ts`):
  Chrome rejects a websocket upgrade whose `Origin` is a page (the guard that
  stops random sites driving your browser), and its `/json/version` carries no
  CORS. The panel *is* a page, so it dials **its own origin** (the channel), and
  the channel — a Node process with no `Origin` — bridges to the browser's CDP
  socket. Plain CDP bytes both ways; **loopback-only** on where it dials.
- **Audio relays** (`realtime.ts` = OpenAI, `gemini-live.ts`, `elevenlabs-realtime.ts`):
  the pipeline opens **one** outbound websocket to the chosen provider **per
  active talk turn**, relaying mic audio up and transcripts/audio down. Opened on
  talk-start, closed on talk-end. Only one provider is chosen per config — always
  verify which from the server's config echo, never assume.

### 9. Dev/reload plumbing
- **`hot.ts`**: `channelSourceDir`, `watchChannelSource` (debounced recursive
  source watch), the `?v=` fresh-import loader used by **manual** reload
  (`channel_reload` / `POST /debug/api/reload`), and `STALE_NOTICE`.

## How the websockets scale

Nothing is quadratic. Every socket is O(connected clients); the two proxy
sockets are **per active turn**, not persistent.

| Socket | Dialed by | Count |
| --- | --- | --- |
| `/ws` | each frontend/panel driving turns | 1 per panel |
| `/tools` | each aiui-instrumented page | 1 per page |
| `/session` | each frontend (presence) | 1 per frontend |
| `/paint` | each iPad | 1 per iPad |
| `/intent/cdp` | the detached page in the CDP tier | 1 per CDP page |
| `/intent/hmr` | Vite (dev only) | 1, dev only |
| `/bar`, `/pencil` | each remote device | 1 per device |
| **upstream** (OpenAI / Gemini / ElevenLabs) | the pipeline | **1 per concurrent talk turn** (opened talk-start, closed talk-end) |

A plain desktop session (one panel, no talking) ≈ **3 persistent sockets**
(`/ws`, `/tools`, `/session`); dictating adds one transient upstream socket; an
iPad adds one. Growth is linear in connected clients + concurrent talk turns.

## The two run modes

- **Development (source checkout).** The whole workspace is *source-first*: every
  package's dev manifest points at `src/…`, and the CLI is spawned as
  `node --import tsx …` (see `aiui/src/util/resolve-cli.ts`). So editing the
  channel **or any workspace package it depends on** takes effect with **no build
  step** — tsx transpiles TS from linked packages on import. No HMR (see below);
  a restart applies edits.
- **Deployed (installed from npm).** The published tarball ships `dist/`, and the
  same resolver runs the built entry. Publishing stays `dist`-based.
- **TS-only shipping (considered, not adopted).** Node's native TS support
  (`--experimental-strip-types`) only *strips* types — it doesn't transpile. The
  **backend** could go strip-only if it avoids TS-only constructs (enums,
  parameter properties, decorators), but that's brittle (one enum reintroduces a
  build). The **frontend can't**: Solid's JSX needs a real transform, so the UI
  keeps its Vite/esbuild build regardless. Verdict: keep `dist` for publish.

## Decisions

### #1 — Sidecar composition by normal imports (done)

**Problem it replaced.** Mounting a sidecar used to take a four-step detour:
`aiui` resolved the package to an **absolute path** (the channel depended on no
sidecar, so a bare specifier failed under pnpm), packed `{name, module, export,
options}` into **JSON**, passed it as `--sidecars` **argv** through Claude
Code's `--mcp-config`, and the channel subprocess `parseSidecarDescriptors` →
`loadSidecars` → `import(<abspath>)`. The indirection existed for exactly one
reason: the four sidecar packages were `--no-publish` dev-deps the channel
couldn't declare.

**What shipped.** Those packages are **published** now, so the channel simply
**depends on them and imports their factories directly** —
`standard-sidecars.ts` calls `paintSidecar({ root })`, `intentSidecar({ root })`,
… and returns a `Sidecar[]`. `runMcp` / `runServe` take an optional
`sidecars: Sidecar[]` and fall back to `standardSidecars(cwd)`; the tests inject
their own (usually `[]`) to stay hermetic. **Deleted:** `load-sidecars.ts`,
`parseSidecarDescriptors`, the `--sidecars` argv/JSON, `aiui`'s
`util/sidecars.ts` (`resolveSidecars` + the absolute-path `resolveModule`
dance), and the whole per-sidecar enable/disable knob — the `--aiui-sidecar` /
`--aiui-no-sidecar` flags and the `sidecars.*` config section (a config file
that still carries `sidecars` is tolerated and ignored, not a hard error).
`aiui` no longer depends on any sidecar package; it gets them transitively
through the channel. The `Sidecar` **contract** stays as the internal mount
seam.

We considered an `aiui`-owned MCP entry (compose in `aiui`, keep the channel
sidecar-agnostic) but chose this: with publishing fixed there is no reason for
the channel not to depend on its sidecars, and letting it import them itself is
a smaller change (the `aiui claude` spawn path barely moves — it just stops
passing `--sidecars`) than standing up a second spawn target.

**Reachability is still `channel.bind`'s job**, never a per-sidecar toggle:
every channel hosts all four, and the bind decides who can reach the port.

### #2 — Staleness notification instead of shallow hot-reload (done)

The old `AIUI_CHANNEL_WATCH=1` path re-imported the **format registry** via
`import(url + "?v=n")` on save — a partial reload that leaked every prior module
copy, left the web server / sidecars / registry untouched, and *looked* like HMR.
Removed. In its place: the same debounced source watch now **tells the agent its
channel is stale** (`pushToSession(STALE_NOTICE, "channel-stale")`) so nobody
trusts behavior that no longer matches disk; the debug `serve` command, having no
agent, narrates the same to stderr. Manual reload (`channel_reload`,
`POST /debug/api/reload`) is unchanged for the deliberate case.

Today the watch covers the channel's **own** `src/` (all backend). Watching its
backend **deps** with front-end-ignoring rules becomes clean once the compiler is
extracted (below) — that's the backend dep worth watching.

### #3 — Keep `dist`-based publish (agreed)

See "TS-only shipping" above.

## Considered next: extract the compiler into a pure-TS package

The lowering pipeline (`intent-v1.ts`, `processors.ts`, the format registry +
`frame.ts` / `codec.ts` / `channel.ts` types, and the `tracing.ts`/`trace.ts`
record seam) is the part worth advancing for lowering research, and it has **no
intrinsic UI or networking dependency** — it's frames in, prompt out, with
generic listener seams (the trace sink, the frame codec). Extracting it into a
pure-TypeScript package (`aiui-lowering` or similar) would:

- give lowering research a dependency-light home (no Express, no `ws`, no MCP);
- make the staleness watcher's "watch the backend deps" precise — the extracted
  package is exactly the backend dep to watch, and everything else the channel
  pulls in (`aiui-dev-overlay`, etc.) is front-end and can be ignored by rule;
- shrink the channel to transport + hosting + observability wiring around it.

Boundary to sever when doing it: the pipeline must take its I/O (push, trace
record, blob store) as injected interfaces, so the package imports neither `ws`
nor `express` nor the MCP SDK. Left as a deliberate next step.

## Publish-time note

All four sidecar packages (`paint`, `intent-client`, `pencil`, `remote-bar`) are
published (`--public`) and are real `dependencies` of the channel, so an
installed channel resolves each `…/sidecar` subpath to its `dist` and imports it
under plain node. `pnpm test:packaging` proves exactly this: it constructs all
four factories from the packed tarballs and mounts the lightweight one. The
channel's own `dist` bundle externalizes them (they are declared deps), so it
never inlines the frontend.
