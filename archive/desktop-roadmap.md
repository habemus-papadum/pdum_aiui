# Desktop roadmap: from spike results to a shipped app, and the packages left behind

**Status:** phases B–F' delivered 2026-07-29 (see the status table below); Phase A deferred by
the user. Originally proposed 2026-07-28.

## Status, 2026-07-29

The packaging track was run end to end, ahead of the panel spike, at the user's direction.

| phase | state | where it landed |
| --- | --- | --- |
| A — panel spike | **deferred**, deliberately | §2 below still stands unchanged |
| B — data path | done | `097a117`…`5d7e6aa`; renderer + sidecar |
| C — the shell | **partially, and only as packaging needed it** | `app://` scheme, sidecar lifetime. The `aiui claude --attach` half is untouched and still belongs to Phase A's world |
| D — packaging | done, except credentials | `c3bc261`, `09cfaf6` |
| E — updates | done, except the repo | `d4210be` |
| F — extraction | not started | still the precondition for eviction |

**The two things that are blocked, and only these:**

1. A **`Developer ID Application`** certificate and Apple notarization credentials. Neither is
   derivable from the repo; this machine has only an `Apple Development` certificate, which the
   pack script now explicitly refuses (it produces something that looks signed and is rejected
   everywhere else).
2. The **`habemus-papadum/cc-miner`** repo the update feed points at. It cannot be this repo —
   `release.yml` already owns the GitHub Releases list here, and electron-updater reads
   `latest-mac.yml` out of whatever GitHub calls the latest release.

**What §1's "unverified" row now says.** Library validation was the predicted first-notarization
failure, and it is real — but not where predicted. `libduckdb.dylib` is re-signed by
electron-builder as part of the bundle and passes. The blocker is the DuckDB extension downloaded
**at runtime** into `~/.duckdb/extensions`, which can never be re-signed by us. Full measurement in
`apps/cc-miner/README.md` → *Signing and notarization*.

---

**Companions:** [`deployment-shapes.md`](./deployment-shapes.md) (what was measured),
[`../guide/duckdb-mosaic.md`](../guide/duckdb-mosaic.md) (the standalone DuckDB/Mosaic
pattern), [`claude-code-usage-analytics.md`](./claude-code-usage-analytics.md) (the data).

Two deliverables, deliberately separated:

1. **A product** — `cc-miner`, installable by someone who has never seen this repo, from a
   notarized DMG or a `.deb`, that queries the full corpus fast.
2. **Patterns** — published `aiui-*` packages carrying the Electron / DuckDB / Mosaic work,
   usable by desktop apps that have nothing to do with Claude Code usage.

The second is not a byproduct. It is the reason `cc-miner` can leave: `pnpm evict:check`
only passes when every workspace dependency is published, so extraction is a *precondition*
of eviction, not a follow-up.

## 1. What is already settled

Everything here was measured, and each phase below leans on specific results. Not
re-litigated.

| area | settled | where |
| --- | --- | --- |
| Two-host dev | Two Vite configs over a shared base; renderer byte-identical in tab and Electron window; HMR in both | commit `96c8217` |
| Shell identity | Electron writes `DevToolsActivePort` into `userData`, Chrome's exact format → an Electron in an aiui profile dir **is** a session browser to every existing consumer | §1.9 |
| Ports | Fixed ports are a trap: a second instance silently gets no debugger *and* clients dialling the port reach the first | §1.9 + measurement |
| Instances | Electron does not enforce profile exclusivity; `DevToolsActivePort` is last-writer-wins. `requestSingleInstanceLock()` fixes it structurally | measured |
| Panes | `BaseWindow` + `WebContentsView` gives real top-level browsing contexts — separate CDP targets, processes, sessions; `getDisplayMedia` works | §1.10 |
| Capture | Extension-origin page in a pane: live `chrome.runtime.id`, `chrome.storage.local`, **and grantless `getDisplayMedia`** (no picker, no gesture) | §1.11 |
| Data path | `ATTACH` does **zero** pushdown (5.26 GB for a `count(*)`); `quack_query` is real remote execution (5 ms, ~0 MB) | §1.13 |
| Mosaic | A 4-line `quackConnector` delegating to `wasmConnector`: crossfilter chart over a 272 MB remote table in **406 ms, ~0 MB to the browser** | §1.13 |
| Versions | Client and server must share a quack build; skew is **fatal to the whole Wasm database** | §1.12 |
| Bundling | DuckDB CLI 17 MB vs node-bindings 112 MB; N-API loads in Electron main *and* `utilityProcess` with no rebuild; the quack extension can be bundled and loaded offline | measured |
| Distribution | Mac App Store and Snap Store are both closed to us — `~/.claude` is a dot-directory, which both sandboxes exclude. Developer ID DMG + plain `.deb` | measured |
| Updates | GitHub Releases works as a feed; drafts are invisible to the updater; macOS needs a `zip` target beside the DMG | verified |

**One simplification worth naming.** The original plan had a "byte resolver" seam so the
browser could fetch Parquet ranges from S3. With Quack, the desktop app never resolves bytes
— the server answers queries. The byte resolver survives **only** for the static-page
deployment (mode 1), and is off the desktop critical path.

## 2. The one open question

Where the **aiui intent panel** lives inside the Electron app. Everything else has a
measured answer; this does not.

### Phase A — the panel spike

Three candidate homes, two of them serious:

| | what it is | measured status |
| --- | --- | --- |
| **(a) MV3 side-panel build** | `dist-ext`'s `index.html` at a `chrome-extension://` origin, hosted in a `WebContentsView` | loads; `chrome.runtime`/`chrome.storage` live; grantless capture works |
| **(b) channel-served plain page** | `http://<channel>/intent/` in a `WebContentsView` | untested in Electron, but it already assumes no extension APIs and drives tabs over CDP |
| (c) DevTools extension panel | `devtools_page` + `panels.create` | works, but an iframe inside DevTools, alive only while DevTools is open, 3 of 8 permissions — **rejected** |

**Prior:** (b) wins. The plain page was built to need no extension APIs, it drives tabs over
CDP, and Electron is a CDP target with a discoverable endpoint (§1.9). Option (a) drags an
MV3 shell along for `chrome.storage` we don't need when there is a real filesystem. But the
spike decides, not the prior.

**Decision criteria — all measurable:**

1. Does the channel wire connect from that origin?
2. Does the CDP driver find the Electron instance via the profile's `DevToolsActivePort`,
   and can it drive the *app* pane (a separate CDP page target, §1.10)?
3. Does capture work, and does `available` report true? (Known gap: `CaptureSource.grantless`
   models this but nothing supplies it in Electron yet.)
4. **Tab identity** — the known hole. The extension stamps `data-aiui-tab` from `chrome.tabs`
   + `chrome.debugger.getTargets()`; `tabs` events never fire in Electron and `chrome.debugger`
   is absent entirely. The shell knows its own `WebContentsView`s, so it can supply identity —
   but it must, explicitly.
5. Does an open turn survive a pane reload?

**A scoping decision to make early:** the panel is a *development* surface. It does not have
to ship in the notarized bundle — the dev Electron config can load it while the production
build does not. That removes it from the packaging critical path entirely. Decide this before
Phase D; if we do want it shipped for dogfooding, it changes signing (an extra extension-origin
payload) but nothing structural.

**Exit:** one option chosen with evidence, and an `ElectronHost` implementing the intent
client's host contract (capture source, tab identity, channel transport).

## 3. Target architecture

```
┌─ Electron main ────────────────────────────────────────────────┐
│  profile = ~/.cache/aiui/userdata/<name>   → DevToolsActivePort │
│  requestSingleInstanceLock()               → one per profile    │
│  BaseWindow                                                     │
│   ├── WebContentsView: the app        (http://localhost:<vite>) │
│   └── WebContentsView: the intent panel   [Phase A decides]     │
│  utilityProcess ── spawns ──▶ duckdb (bundled CLI, 17 MB)       │
│                               LOAD quack; quack_serve(…)        │
└────────────────────────────────────────────────────────────────┘
         renderer ──HTTP POST /quack──▶ the DuckDB server
         (Mosaic → quackConnector → duckdb-wasm as protocol client)
```

Three properties this preserves, each already demonstrated:

- **The renderer is identical in a tab and in a window.** Host detection is runtime
  (`src/host.ts`), never a build flag.
- **The transport is HTTP in both hosts.** No `ipcRenderer` in app code — the seam that
  keeps the browser build honest (see `deployment-shapes.md` §2).
- **Mode 1 still works.** Swap the connector and the same app runs as a static page.

## 4. Phases

Each phase has an acceptance criterion that is *measured*, in keeping with how everything
above was decided.

### Phase B — the data path

Land `quackConnector` in `cc-miner`; bundle the DuckDB CLI + quack extension; spawn it from
`utilityProcess`; boot it with a SQL script that attaches local Parquet (and later S3).

- Pin duckdb-wasm to **dev64** (v1.5.5 / quack `c154811`) to match the server; add a startup
  assertion that client and server quack builds are equal, because the failure is fatal and
  silent-looking (§1.12).
- Set `extension_directory` to the bundled extension; `autoinstall`/`autoload` off (verified).
- Keep the Wasm+local-Parquet path behind the same seam so the gallery/static deploy survives.

**Acceptance:** the full raw corpus (~289 MB/host, currently unqueryable in Wasm) drives every
existing panel; a crossfilter drag re-renders in **< 500 ms**; wire bytes per interaction in
**single-digit MB**. Numbers, not impressions.

### Phase C — the shell

- Profile → `userData`; `requestSingleInstanceLock()`; CDP port from the profile, never fixed.
- `BaseWindow` + panes; the Phase-A panel; grantless capture handler.
- `aiui claude --attach [profile]` — a third provenance for `browserUrl` alongside launch and
  tunnel, with zero-arg disambiguation via `discoverSessionBrowserInProfiles()`.
- Teach the profile marker that a profile is Electron-owned, so a later Chrome launch into the
  same `userData` refuses rather than corrupting it.
- **Ordering decision still open:** attach requires the browser to exist before the MCP config
  is written. Either the app starts first, or the port is derived from the profile name so both
  sides agree without communicating. Resolve at the start of this phase.

**Acceptance:** `aiui claude --attach` finds the running app with no port typed anywhere; a
full intent turn round-trips from the Electron window into the session.

### Phase D — packaging

Developer ID signing, hardened runtime, notarization, DMG + `zip`, and a `.deb`.

- Everything executable ships inside the bundle. No runtime downloads — which is exactly why
  SpinDB/hostdb was rejected (a 61 KB URL registry that fetches binaries at runtime, pinned to
  DuckDB v1.1.3).
- Expect to need `com.apple.security.cs.disable-library-validation`: the quack extension is a
  25 MB Mach-O signed by DuckDB, not by us, and hardened runtime enforces library validation.
  **Unverified** — the most likely first-notarization failure.

**Acceptance:** a machine that has never had Node, pnpm, or this repo installs the artifact and
it runs. Verified on a clean user account, not the dev machine.

### Phase E — updates

`electron-updater` against GitHub Releases.

**Acceptance:** an installed build detects and applies a newer release. Watch the two traps —
electron-builder creates **draft** releases by default and drafts are invisible to the updater;
macOS needs the `zip` target or `latest-mac.yml` is never generated.

### Phase F — extraction, then eviction

Only now, when the shapes have been proven by use.

| new package | contents | why it is reusable |
| --- | --- | --- |
| `aiui-electron` | profile→userData, single-instance lock, CDP discovery, `BaseWindow`+panes, grantless capture, extension loading, `utilityProcess` sidecar lifecycle | knows nothing about cc-miner |
| `aiui-duckdb-host` | bundled CLI + extension, spawn/health-check/shutdown, SQL boot-script contract | any DuckDB desktop app |
| `aiui-viz/quack` (or standalone) | the `quackConnector` | ~10 lines, useful to any Mosaic app |

**The reusability test is a second consumer, not an assertion.** A trivial second demo app
must run on the same three packages before extraction counts as done. Then publish, then
`pnpm evict cc-miner cc-assay` — which passes only because these are on npm.

## 5. Sequencing and what can run in parallel

```
A (panel spike) ─────┐
                     ├──▶ C (shell) ──▶ D (packaging) ──▶ E (updates) ──▶ F (extract, evict)
B (data path) ───────┘
```

A and B are independent — B is pure renderer + sidecar, A is pure shell. B carries the
user-visible performance win and is fully de-risked, so it is the safer thing to start.

## 6. Open questions, honestly listed

- **Attach ordering** (Phase C) — app-first, or derive the port from the profile name.
- **Library validation** (Phase D) — the notarization entitlement, unverified.
- **Panel shipping** (Phase A) — dev-only surface, or in the product bundle.
- **Quack over TLS and real latency** — everything measured was loopback. At 3 RPC calls per
  query latency should matter less than for `ATTACH`, but that is reasoning, not measurement.
- **Token handling** — fine for a local sidecar; unresolved for a hosted server.
- **S3** — `username`, Hive layout, `index.json` are still unbuilt. Quack changes where they
  are consumed (the server reads S3, not the browser) but not whether they are needed.
