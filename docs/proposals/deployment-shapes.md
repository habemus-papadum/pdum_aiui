# Deployment shapes: one app, three hosts, one seam

**Status:** proposed. Based on three parallel spikes (branches
`worktree-agent-a42a107a417764b6a`, `-a9ca018e71e265e51`, `-a5600f7749efed279`)
plus direct measurement against `apps/cc-miner`.
**Date:** 2026-07-26.
**Companion:** [`claude-code-usage-analytics.md`](./claude-code-usage-analytics.md)
— that document designs the *data*; this one designs *where it runs*.

## The question

`apps/cc-miner` today is a static page: Parquet arrives as Vite `?url`
assets, DuckDB-WASM runs in the tab. Three pressures push on that at once:

1. **Multi-machine.** Usage data lives on several machines; it should merge in
   one view. That suggests object storage.
2. **Desktop.** The eventual shipping form is a code-signed Electron app.
3. **Scale.** The raw layer is 289 MB *per host* and DuckDB-WASM cannot query it
   usefully (§1.1).

The temptation is to answer each separately and end up with three codebases. The
claim of this document is that **one seam answers all three**, and that the seam
is narrower than it first appears.

## 1. What was measured

Everything in this section was run, not reasoned. Where a number is inherited
rather than re-verified, it says so.

### 1.1 DuckDB-WASM does not range-read

DuckDB-WASM reads `read_parquet('https://…')` directly — no `INSTALL httpfs`,
returns correct rows. But it downloads the **whole file regardless of the
query**:

| query | file | bytes moved |
| --- | ---: | ---: |
| `SELECT count(*)` (footer only) | 3.8 MB | **100%** |
| `SELECT count(*)` (footer only) | 289 MB | **100%** |

The runtime probes with `HEAD` + `Range: bytes=0-` and uses ranged reads only if
the server answers **206**. I wrote a server that answers 206 to ranged HEADs;
it still pulled 100%. So predicate pushdown and Hive partitioning buy **nothing**
in the browser today. This is the constraint the rest of the design lives under.

### 1.2 A backend does range-read, decisively

Spike 1 built a Node WebSocket server speaking Mosaic's socket protocol over
`@duckdb/node-api`, and pointed it at the same 289 MB file over HTTP:

| query | time | bytes | % of file |
| --- | ---: | ---: | ---: |
| `count(*)` | 6 ms | 262,144 | **0.091%** |
| selective filter | 4 ms | 462,386 | 0.160% |
| filtered group-by | 4 ms | 1,079,404 | 0.373% |
| full read of a fat JSON column | 11.5 s | — | 100.087% |

The range log shows a HEAD, one 256 KB footer read, then targeted GETs of
**57, 195 and 243 bytes** across three row groups. Through the socket connector
end-to-end, `count(*)` over 289 MB was **1.1 ms and 272 bytes on the wire**.

### 1.3 …but the backend's win is not bandwidth

For *this* app the backend moved slightly **more** data:

| | WASM (today) | socket backend |
| --- | ---: | ---: |
| Parquet transferred | 9,054,857 B | 0 |
| query results over the socket | 0 | 9.68 MB / 29 queries |
| `duckdb-eh.wasm` | 35,916,979 B | **0** |
| time to summary / session graph | 1067 / 1081 ms | **239 / 247 ms** |

Two call sites cause it: the replay query returns **8.05 MB of JSON where the
Parquet was 3.37 MB** (~2.4×), and the scatter pulls all 30,420 rows. The real
wins are **the absent 36 MB WASM binary and 4.4× faster time-to-ready**.

**Caveat added 2026-07-27, and it softens this section.** That 8.05 MB was
measured with `{ type: 'json' }`, so an unknown part of the regression is
*encoding*, not payload. Mosaic's default is `arrow` — `query()` returns a
flechette `Table`, and `type: 'json'` is the opt-out. Over a socket connector
the result encoding IS the wire format, so Arrow should be the default there
too, and this table should be re-measured before "the backend moves more bytes"
is treated as settled. What does not change with encoding: the scatter genuinely
pulls 30,420 rows, so that call site is a real port either way.

### 1.4 The connector swap is one line; the couplings are not

90 insertions / 41 deletions, **all in `store.ts`**. No component, no cell, no
SQL string changed, and results were byte-identical across both modes
(`7,804 turns / 36 sessions / $2238.0468672499924`).

What actually had to change:

- **`store.sql()` bypassed Mosaic entirely**, going straight at the WASM
  connection, with ~20 call sites in `graph.ts`. Routing it through the
  coordinator fixed all of them without touching a call site. **This is the real
  finding** — see §2.1.
- `querySummary` typed on `AsyncDuckDBConnection`; `ensureReplay`'s
  `registerFileBuffer` is WASM-only; `Engine.db`/`.conn` become nullable;
  optional-grain discovery (a deliberate 404 probe) has no backend analogue.

### 1.5 Electron: the dev loop is free

Spike 2, confirmed by me against the real app:

- **HMR works** in an Electron renderer pointed at the Vite dev server —
  verified by stamping a load id from an inline `<script>` in `index.html` and
  observing it survive a component edit.
- **CDP attaches**: `/json/list` shows one target typed `page`. Every
  measurement in that spike was taken through that WebSocket, which is itself
  the proof that agent tooling can drive it.
- **~40 lines of main-process code**, and **zero Electron-aware lines in app
  source**.
- Use `app://`, not `file://`. `file://` renders a blank page under Vite's
  default `base` and can carry no CSP/COOP/COEP; `app://` is a real origin.
  It is *fewer* moving parts, because the same untouched Vite config builds for
  both dev and prod.

### 1.6 DuckDB-WASM under Electron: works; SharedArrayBuffer is a red herring

I ran the real `apps/cc-miner` build (110 MB `dist`, 95 emitted Parquet
files) under Electron in five configurations:

| # | configuration | origin | `crossOriginIsolated` | `SharedArrayBuffer` | app |
| --- | --- | --- | --- | --- | --- |
| A | `app://` + COEP `require-corp` | `app://bundle` | **true** | present | ok |
| B | `app://`, no COEP | `app://bundle` | false | **absent** | ok |
| C | dev `http://localhost` | http | false | **absent** | ok |
| D | `app://`, CDN blocked | `app://bundle` | false | absent | **fails** |
| E | `app://`, extensions self-hosted | `app://bundle` | false | absent | ok |

Every working row loaded the full corpus (`$11385 / 30,420 turns / 104
sessions`), answered `{n: 30420, cost: 11384.53}`, and rendered 400 replay
blocks from a 3.4 MB Parquet.

**A and B are the SharedArrayBuffer answer**: identical app, one with SAB and
one without, behaving the same. This repo ships `mvp` + `eh` and never `coi` —
a decision taken for static-S3 hosting, documented in `aiui-viz/src/duckdb.ts`,
which happens to immunise the Electron target too. The lone SAB reference in the
`eh` worker sits inside a `typeof XMLHttpRequest === "undefined"` branch — the
Node path, dead in a renderer.

Electron's COI asymmetry is real (dev `http://localhost` gets no isolation even
with correct headers; `app://` does) but only bites a **threaded** bundle. The
standing rule that follows: **feature-detect `SharedArrayBuffer` directly, never
`crossOriginIsolated`.**

### 1.7 The dependency that does bite: `extensions.duckdb.org`

Row D is the finding, and **it is not Electron-specific**. DuckDB-WASM fetches
`parquet.duckdb_extension.wasm` and `json.duckdb_extension.wasm` from
`extensions.duckdb.org` **at runtime, on first query**. Block it and the app
dies with `no data yet` and a raw
`RuntimeError: null function or function signature mismatch` — an opaque WASM
failure, not a clean error.

**Scoped down by decision, 2026-07-27: an open internet connection is assumed.**
Offline operation is explicitly not a requirement, which demotes this from a
defect to a robustness note. What remains true and worth knowing: it is a
third-party dependency on the *first-query* path, so a CDN outage or an
egress-restricted network still produces the opaque failure above, and it costs
~4 MB of cold-start download. Neither is a blocker.

Row E verifies the fix should it ever be wanted: serve the bytes from your own
origin. Two details worth keeping — Chromium **aborts** a `https:` → `file:`
redirect, but accepts `https:` → `app://` because that is a registered
privileged scheme; and for a static page the equivalent lever is DuckDB's own
`custom_extension_repository`.

### 1.8 The Electron extension host is unnecessary

Spike 3, on Electron 43.2.0 / Chromium 150. Electron loads unpacked MV3 better
than predicted — real module service worker, honours the manifest key
(reproduced our exact extension id), content scripts with genuine
ISOLATED/MAIN world separation. But the whole `chrome.*` surface is eight
namespaces: `action, extension, i18n, management, runtime, scripting, storage,
tabs`. **`sidePanel` and `tabCapture` are absent**, and `tabs` events never fire.

The finding that matters: `session.setDisplayMediaRequestHandler` pointed at a
chosen frame, then `getDisplayMedia` from the page, yields a **live, app-chosen
capture with no picker and no user gesture** — proven by drawing a frame to a
canvas. `webContents.capturePage()`, `webContents.debugger` +
`Page.captureScreenshot`, and `Page.startScreencast` all work too.

So the extension host's *central premise* is void in Electron: the whole
invocation-gesture / grant apparatus in `BEHAVIOR.md` exists to satisfy a Chrome
permission gate Electron does not impose. `CaptureSource.grantless` already
models this.

## 2. The design

### 2.1 Two nested seams, not one

The mistake in my first sketch was proposing a *file-shaped* seam (`list()` +
`url(path)`). The spikes say there are two seams, nested, and the outer one is
Mosaic's, which already exists:

**Seam 1 — execution.** `coordinator.databaseConnector(…)`: DuckDB in the page
(`wasmConnector`) or DuckDB in a process (`socketConnector`). This is one line
*provided* every data access goes through the coordinator — which today it does
not (§1.4). **Routing `store.sql()` through the coordinator is the prerequisite
for everything else in this document**, and is worth doing on its own merits.

Use the **default `arrow` result type**, not `{ type: 'json' }`. Mosaic decodes
to a flechette `Table` whose `toArray()` yields row objects directly, so the
rewrite is *shorter* than the code it replaces and `unwrapBigInts` still applies:

```ts
const result = await e.coordinator.query(query);
return result.toArray().map((r) => unwrapBigInts(r as Record<string, unknown>) as T);
```

Under `wasmConnector` the encoding is in-process and near-free either way. Under
`socketConnector` it is the wire format — see the caveat in §1.3.

**Seam 2 — bytes.** Only meaningful under `wasmConnector`: do the Parquet bytes
come from bundled `?url` assets, or from an HTTP origin (a directory server, or
S3)? This is a small resolver, not an abstraction layer — it answers "what URL",
and DuckDB does the rest.

The three deployment shapes are then combinations, not forks:

| shape | seam 1 | seam 2 |
| --- | --- | --- |
| static web page | wasm | bundled assets or an HTTP base |
| Electron, self-contained | wasm | bundled assets over `app://` |
| Electron or web + backend | socket | n/a — the backend owns bytes |

**No app code knows which.** That is the property to protect, and §1.5 shows it
already holds for Electron (zero Electron-aware lines) and §1.4 shows it holds
for the connector (no component or SQL changed).

### 2.2 When to reach for the backend

Not by default. The rule that falls out of §1.2 and §1.3:

- **Grains (5.69 MB)** — WASM. 91 ms at 500 Mbps. A backend makes this *worse*.
- **Replay (3.4 MB per session, on demand)** — WASM. Already partitioned.
- **Raw layer (289 MB per host)** — backend, or not in the browser at all. WASM
  pulls 100% of it; native pulls 0.091%.

So the backend is the answer to *one* question — querying the raw layer — and
should be introduced when that capability is wanted, not as a migration.

### 2.3 S3 layout

Hive-style, so `hive_partitioning=true` yields a free `host` column, and so a
per-host upload is a directory write:

```
s3://<bucket>/cc/v1/
  index.json                        ← what exists; hosts, sizes, mtimes, schema version
  host=<hostId>/
    turns.parquet  toolCalls.parquet  sessions.parquet  …
    replay/<sessionId>.parquet
    raw/raw.parquet  raw/files.parquet     ← backend-only; never fetched by a page
```

`index.json` is how the app learns what is available — the same pattern
`replay/index.json` already uses, so there is precedent in the codebase rather
than a new idea.

Partitioning by `host=` is for **organisation and incremental upload**, not for
browser performance — §1.1 is explicit that pushdown buys nothing in WASM. It
starts paying off the moment a backend is in play.

### 2.4 `username`, beside `hostId`

`hostId` is already a column on `turns` and `sessions`. `username` joins it, for
the same reason: a shared bucket needs to say *whose* machine. Both belong in
`host.json` as the source of truth and are threaded through the same path
`hostId` already takes. One dictionary-encoded string column each; the cost is
noise.

### 2.5 Electron shell

`app://` custom protocol, ~40 lines in the main process, the app built by the
same untouched Vite config. `aiui-electron-framework` is worth *much less* than
first assumed — there is no hard problem. What a thin package should own:

- the `app://` handler with correct privilege flags, a path-traversal guard and
  SPA fallback;
- an isolation-parity switch, plus the "feature-detect SAB" rule;
- optionally, the self-hosted DuckDB extension redirect (§1.7) — descoped, but
  the mechanism is measured and cheap to add if a CDN dependency ever bites;
- desktop affordances as they arise (status bar, menus).

Explicitly **not** in scope: wrapping HMR (needs no help), proxying CDP (already
a plain Chrome target), or any IPC/preload layer. **Zero Electron-aware lines in
app source is the framework's contract.**

### 2.6 Intent client: an `ElectronHost`

Ship on the **plain-page host**, reclassified as an `ElectronHost` driving
in-process `webContents.debugger` CDP rather than a remote debug port — no port,
no external browser, no session-browser discovery, and `ctx.cdpAlignment`
collapses to "aligned by construction". Do not port the MV3 host.

## 3. What to fix regardless of any of this

Three defects surfaced that are live in `main` today and are not contingent on
adopting anything here:

1. **A re-entrancy deadlock**: routing `querySummary` through the public `sql()`
   hangs boot forever at "summarizing" with no error, because `sql()` awaits
   `ensureLoaded()` — which is the `load()` calling it. Latent; any "make loading
   uniform" refactor walks into it.
2. **Unguarded extension namespaces**: `chrome.contextMenus.onClicked` at module
   top level in `sw.ts:117` takes the whole service worker down on any Chromium
   host that lacks it, and `chrome.windows.getCurrent()` blanks the panel. Any
   non-Chrome host, not just Electron.

Also minor: 22 of 109 replay Parquet files are under Vite's 4 KB inline limit and
get base64-inlined into the entry chunk. `assetsInlineLimit: 0` is probably right
for this app.

## 4. Sequencing

Ordered so each step is useful alone and none is wasted if the next is dropped.

1. **Route all data access through the coordinator** (§2.1, seam 1). No behaviour
   change; unblocks everything; fixes defect 1 on the way.
2. **`username` + the S3 layout** (§2.3, §2.4) in the ingestion tools, with
   `index.json`. Still WASM-only, still a static page.
3. **The byte resolver** (§2.1, seam 2) so a page can read grains from an HTTP
   base instead of bundled assets. This is what makes multi-machine work in the
   browser.
4. **Electron shell** (§2.5) — packaging, no app changes.
5. **The backend**, when raw-layer querying is wanted (§2.2). Port the replay and
   scatter call sites at the same time (§1.3), or it is a regression.

Steps 1–3 need no Electron and no backend. Step 5 is the only one that is
genuinely large. Self-hosting the DuckDB extensions (§1.7) is deliberately NOT
in this list — see the scoping decision there.

## 5. Risks and open questions

- **Arrow type fidelity fails silently.** Spike 1 encoded TIMESTAMP as float64
  and got no server error — just `RangeError: Invalid time value` from four
  unrelated components and an axis reading `1,782,000,000,000`. DECIMAL, LIST,
  STRUCT and ENUM carry the same risk. Any backend needs a type-fidelity test
  suite before it is trusted.
- **Do not use DuckDB's `arrow` extension.** It 404s in core and core_nightly,
  `arrowIPCAll` fails on ordinary views while identical inline `read_parquet()`
  succeeds, and pushed further it **segfaults**. The working path is
  `@duckdb/node-api` + `@uwdata/flechette`.
- **`socketConnector` is strictly serial** — one in-flight, FIFO, no reconnect,
  and `close` rejects the whole queue. A dropped backend does not degrade; every
  pending panel rejects at once.
- **Native modules fight the browser-first premise.** `@duckdb/node-api` is a
  native `.node`: `asarUnpack`, individual signing under hardened runtime,
  `electron-rebuild`, per-arch builds — and it tends to reintroduce a
  preload/IPC layer, which is exactly what puts Electron-aware branches into app
  code. **Mitigation to evaluate: run the backend as a spawned sidecar process
  rather than in-process**, so the renderer still talks to a socket and app
  source stays clean.
- **Not yet verified**: signing and notarisation (not attempted); Windows and
  Linux; whether the intent client's panel renders once the two guards in defect
  3 are added (the failure was measured, the fix is inferred); and whether
  `custom_extension_repository` is the right lever for the static-page shape
  (only the Electron redirect was proven).
- **Version sensitivity**: Electron's MV3 support arrived ~Electron 35 and is
  improving, but `sidePanel`/`tabCapture` are *structurally* absent — they
  presume browser chrome Electron lacks. Do not plan around them arriving. The
  inert `tabs` events look like a plumbing gap worth re-measuring on bumps.
