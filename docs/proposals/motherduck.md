# MotherDuck in the tab: the design, the seams, and what was measured

Status: ACCEPTED 2026-09-24 and BUILT the same day — Track A (the kit's `cf-creds-motherduck`,
0.5.0, released) and Track B (this repo, 0.19.0 pending release). Probes 1, 2, 4, 5, 6, 7 and 8
answered (§5); probe 3 open. This document is self-contained: it covers the two repos that hold
the engine and its seams. A deployment — the broker route that mints tokens, the declared service
accounts, the data load, the host's wasm serving — is a consumer's plan and lives with the
consumer, not here; §3 states the contract such a deployment meets. The measured facts behind every
rule, and the record behind the one non-obvious one, are in
`packages/aiui-viz/docs/duckdb-mosaic.md`, Part 4b.

## 0. The objective, and the sentence that decides the design

An aiui app that a person runs locally and deployed, reading a dataset that lives in MotherDuck,
in the tab, directly or through Mosaic, with dual execution (a local table joined to a cloud table
in one statement), and never fetching its wasm from a third-party CDN. The person's flow:

1. upload a dataset to MotherDuck;
2. share it with a service account whose compute is the audience's tier;
3. run the app locally and see the data;
4. publish the app and have the deployment serve the wasm correctly.

The sentence: **`@motherduck/wasm-client` is the stock duckdb-wasm build plus an extension,
and it exports the stock `AsyncDuckDB`.** Verified 2026-09-24: its hosted `duckdb-eh.wasm` is
byte-identical (sha256) to `@duckdb/duckdb-wasm@1.33.1-dev64.0`'s; its bindings are that
version vendored; at boot it runs `INSTALL motherduck FROM 'https://ext.motherduck.com/<ver>'`
then `LOAD motherduck`. So there is ONE engine, Mosaic's own `wasmConnector({ duckdb, connection })`
drives it unchanged (Arrow IPC → flechette, today's path), the agent's `sql`/`schema` tools ride a
`SqlRunner` over it, and `registerFileBuffer` on that engine is the stock API. No new aiui package
is warranted; the seam is "where does the engine come from and who holds the token", which is a
`duckdb.ts`-level decision in each app plus one bridge module.

## 1. Facts that constrain the design

| fact | consequence |
| --- | --- |
| Compute (Duckling size, read-scaling flock) is a property of an ACCOUNT, never a token, query or session | "tier for (site, user)" means "which service account's token to mint" |
| Data access is a property of a ROLE (share granted to role; accounts and people are members); revoke is immediate for new sessions | one role per audience, one share per dataset, one grant per member |
| A read-scaling token cannot `ATTACH`; the service account must attach the share ONCE with a read-write token | one hand step outside the declarative graph (a scripted verb) |
| Token TTL 300 s…1 y; `POST /v1/users/{account}/tokens {name, ttl, token_type}` with an admin's read-write PAT; `DELETE` revokes at next connect | the minter is a plain REST call with a worker secret; the token `name` carries the visitor's identity |
| The official OpenTofu provider `motherduckdb/motherduck` (0.2.12, 2026-09-24) has `_service_account`, `_duckling_config`, `_access_token`, `_database`, `_share`, `_share_grant`, `_role`, `_role_grant`; `MOTHERDUCK_TOKEN` for SQL resources, `MOTHERDUCK_ADMIN_TOKEN` for REST ones; an admin's PAT serves as both | a deployment declares accounts, compute, roles, shares and grants; no generic REST provider needed |
| The client's `MDConnectionParams`: `mdToken`, `duckDBAssetsURLPrefix` (a `/`-relative prefix resolves against `window.origin`), `attachMode`, `sessionName`, `customUserAgent`; do NOT pass `accessMode: "read_only"` (it applies to the tab's own DB and fails); the read-scaling token is what makes the cloud read-only | self-hosting the wasm is one option; workspace attach mode is the proven one |
| The client loads assets at `<prefix>/duckdb-wasm-assets/<version>/{duckdb-eh.wasm, duckdb-browser-eh.worker.js, …}`; MotherDuck's copy is brotli at rest (36 MB → 5.3 MB, `content-encoding: br`, immutable) | the self-host layout is fixed; brotli-at-rest is the serving recipe for every wasm connector |
| Cloudflare Workers Static Assets sites cap a file at 25 MiB (still, 2026); an R2-backed host does not, but sets no `Content-Encoding` on its own | raw wasm publishes on an uncapped host today; a capped host needs `duckdbAssets: { brotli: true }` served with `Content-Encoding: br` |
| The kit (`cf_browser_credentials`) publishes browser packages only; `CredentialManager<C>` needs just an ISO `expiration`; AWS is the "session" species | `cf-creds-motherduck` is a session-species package |
| A consumer app installs aiui from npm | aiui changes must be RELEASED (0.19.0) before a consumer can use them; `link:` for development |
| Mosaic's official MotherDuck example returns apache-arrow tables and dates from vgplot 0.3; Mosaic 0.31.0's "MotherDuck fix" (PR #1148) tolerates that and an empty `DESCRIBE`; upstream duckdb#16017 closed 2025-02 | using the stock connector sidesteps both; mosaic stays at 0.28.1 |
| mosaic-sql `from("db.main.t")` is ONE quoted identifier; `from(["db","main","t"])` is qualified | pass arrays, or bridge with a local view/temp table (§5 item 6: the view) |

## 2. The shape, end to end

```
a deployment (Tofu)                    MotherDuck                       the tab
───────────────────                    ──────────                       ───────
service account "reader"  ──────────▶ account (rw size; rs size × flock)
duckling_config           ──────────▶ (the TIER lives here)
role "readers"            ──────────▶ role
share "dataset" → role    ──────────▶ share (restricted, hidden, automatic)
role_grant reader, owner  ──────────▶ members
grants[site].motherduck = {sa, ttl}   ┐
worker /api/credentials/motherduck ───┼── POST /v1/users/reader/tokens ──▶ {token, expiration}
  (identity → lane → sa)              ┘                                        │
                                                                               ▼
                       cf-creds-motherduck: CredentialManager → engine (MDConnection,
                       getAsyncDuckDb) → aiui-cf-creds/motherduck → wasmConnector +
                       motherDuckRunner → Mosaic views + sql/schema tools (unchanged)
```

Two hand steps stay outside the graph, both scripted by the deployment: the data load (a loader
fills the declared database) and the service account's one-time `ATTACH` of the share.

## 3. (site, user) → tier: the contract a deployment meets

The mapping has three layers, each already the right owner's job:

1. **The deployment declares accounts and their compute.** A map, one entry per lane:
   ```hcl
   locals { motherduck_lanes = {
     reader = { rw = "pulse", rs = "standard", flock = 2, rs_cooldown = 60 }   # a page's visitors
     batch  = { rw = "standard", rs = "pulse", flock = 1, rw_cooldown = 60 }   # the loader
   } }
   ```
   realized as `motherduck_service_account` + `motherduck_duckling_config` per entry
   (`for_each`), each a `motherduck_role_grant` member of the audience role. A new tier is a
   new entry; resizing is an edit and an apply (30–60 s to take effect).
2. **The broker's grant names the lane a site mints for, and optionally per-identity overrides:**
   ```hcl
   my-note = { motherduck = {
     serviceAccount = motherduck_service_account.lane["reader"].username
     ttlSeconds     = 3600             # covers the connect; the session outlives the token (§5)
     tokenType      = "read_scaling"
     lanes = [                          # optional; first match wins, else the default above
       { emails = ["someone@example.com"], serviceAccount = "heavy" },
     ]
   } }
   ```
   The route receives the visitor's identity (the Access email or a service token's name),
   matches `lanes` against it, and mints `{ name: identity + "#" + mintTime, ttl, token_type }`
   (§5 item 8: names are required and unique among live tokens). Who may mint at all, and who
   can reach the page, are the broker's and the door's existing policies, unchanged.
3. **The page names only itself** (`?key=my-note`) and never the account, the tier or the TTL —
   the kit's key contract.

What is deliberately NOT declared: the token strings for pages (minted per visitor), the data
load, and the one-time attach.

## 4. What was built, by repo

### Track A — the kit (`cf_browser_credentials`, 0.4.1+dev → 0.5.0) — BUILT 2026-09-24

A1. `packages/cf-creds-motherduck` (scaffolded with `pnpm new-package`). Exports: `MotherDuckCredentials`,
   `MOTHERDUCK_CREDENTIALS_PATH`, `motherDuckCredentialsUrl`, `createMotherDuckCredentialManager`
   (the session species, a plain `CredentialManager`), `TokenSource` + `staticMotherDuckToken`
   (dev/paste), `motherDuckEngine(source, params, { client?, rebuildOnRotate? })` →
   `{ ready(), rebuild(reason), onRebuild(fn), generation, close() }` with a handle
   `{ db, connection, connect(), generation }`, `isMotherDuckAuthError`. The client is a lazy
   `import("@motherduck/wasm-client")` (optional peer, injectable for tests); `accessMode:
   "read_only"` is refused up front. Default `rebuildOnRotate: false` — measured (§5).
A2. 12 tests over a scripted client and a rotating source (route URL, caching, no rebuild on
   rotate by default, eager rebuild when asked, explicit deduplicated rebuild, close, refusal).
A3. README = `docs/packages/cf-creds-motherduck.md`, sidebar entry, species table + package map in
   `docs/index.md`, the worker doc's provider paragraph, the stale "key requires base" sentence
   fixed in the core README and its docs copy. Docs site builds.
A4. Release 0.5.0 — CI only (`gh workflow run release.yml -f bump=minor`), authorized by the owner.

### Track B — this repo (0.18.0+dev → 0.19.0) — BUILT 2026-09-24, live-verified

B1. Catalog + override `@duckdb/duckdb-wasm` → 1.33.1-dev64.0 (the client's vendored build; DuckDB
   1.5.5); every package and demo typechecks.
B2. `aiui-util` `VENDOR_KEYS` gains `motherduck` (`MOTHERDUCK_BROWSER_TOKEN`, **opt-in**: the launch
   gap-fill never asks, the preflight never reports it; `aiui keys set/interview` and `devKeys` reach
   it); CLI parses providers from the registry; config schema/type rows; guide passages.
B3. `aiui-cf-creds/motherduck`: `devMotherDuckEngine` / `brokerMotherDuckEngine` /
   `standardMotherDuckEngine` (dev key if injected, else the broker), the handle RE-TYPED to the
   stock duckdb-wasm classes at this one boundary (the client vendors its own copy; protected
   members make the classes nominal), and `motherDuckRunner` — the agent's runner over the client's
   own query protocol (the rule in §5 item 5). Kit deps lifted to ^0.5.0. Six tests.
B4. `aiui({ duckdbAssets: true | { brotli } })` publishes the installed duckdb-wasm at
   `<base>duckdb-wasm-assets/<version>/…` (dev middleware + unhashed build assets) and seeds
   `__AIUI__.duckdbAssets`; `aiui-viz/duckdb` reads it back (`duckdbAssetsLocation`,
   `duckdbAssetBundles`). Three plugin tests + two viz tests.
B5. `demos/motherduck-lab` (no gallery marker): session, table/column pickers, two linked
   histograms over a cloud table through a local view, materialize + hybrid count, rebuild, the
   standard + `sql`/`schema` tools and four verbs. Driven live in headless Chrome with a
   read-scaling token of the owner's own user as the dev key: wasm from the app's origin, schema
   across catalogs, typed SQL, histograms in 295 ms, cube built, 50 k rows materialized, hybrid count
   186 k, rebuild → generation 2 with the sample gone and the cloud intact, a brush after the rebuild
   recreating its cube, zero console errors.
B6. Docs: duckdb-mosaic.md "Part 4b — MotherDuck in the tab (shape 4)" + the choosing row; the
   bridge's README/getting-started; the lab's README; `test:packaging` green.
B7. Release 0.19.0 — CI only, triggered by the owner.

### Downstream — a consumer's plan, kept with the consumer

Everything past B is a deployment's work and is documented there, not here: a broker worker's
`/api/credentials/motherduck` route (§3 layer 2, the kit's worker doc has the route's shape), the
declared lanes and share (§3 layer 1), the scripted attach and a health probe, a loader that fills
the database, an app that composes `standardMotherDuckEngine` with Mosaic and the SQL tools
exactly as the lab does, and — for a host that caps file sizes — brotli-at-rest for the wasm.

## 5. Probes — answered 2026-09-24 (headless Chrome, wasm-client 1.5.5-r.1, a service account's Standard flock)

1. **Token expiry on a live session — ANSWERED: the session outlives its token.** A session made
   with a 5-minute read-scaling token kept answering remote, local and hybrid queries for 8
   minutes of 20 s polling (3 past expiry); a session left idle 6.5 minutes (past expiry AND the
   flock's 60 s cooldown, so a replica had to wake) answered its next remote query in 700 ms with
   its local tables intact; revoking the connect-time token did not stop a live session either.
   The extension holds a session, not the token. So the token's TTL only has to cover the
   connect; the engine is NOT rebuilt on rotation (the kit's default), a rebuild is explicit and
   app-timed; grant TTL 3600 s (a mint per open tab per ~50 min at the manager's 10-min margin,
   keeping MotherDuck's token list short).
2. **In-place token swap — ANSWERED: impossible.** `SET motherduck_token` after init: "can only be
   set during initialization"; `DETACH` of the workspace: refused for read-only credentials;
   `ATTACH 'md:'`: "already attached". Only `terminateDuckDB()` + create, which drops local tables.
3. `attachMode: "single"` + `databasePath` vs the proven workspace mode — still open.
4. **Pre-aggregation — ANSWERED: leave it on.** Over a 766 k-row remote table through a local
   view, two linked histograms + crossfilter: the cube `memory.mosaic.preagg_…` was created in
   59 ms (dual execution ran the group-by on the Duckling, the cube came down), and every brush
   afterwards was a 4–8 ms local query over the cube. cc-miner's `preagg: false` was about
   cross-table clauses, not remote tables.
5. **`information_schema` across catalogs — ANSWERED, with a hazard.** The `schema` tool lists
   every attached catalog's tables raw. But **`MD_ALL_DATABASES()` under duckdb-wasm's blocking
   `RUN_QUERY` protocol (`connection.query()`, Mosaic's `runQuery`) never returns and wedges the
   whole engine** — alone, every time, every connection with it — while the same statement on the
   same raw connection through the pending-query protocol (`connection.send()`, which is what the
   client's `evaluateQuery` uses) answers in about 200 ms. `md_user_info()`,
   `md_live_duckling_size()`, `duckdb_databases()`, `information_schema.*`, `DESCRIBE` and table
   scans are fine under either. Rule: Mosaic on a raw connection (its SQL never calls `md_*`),
   free-form SQL (the `sql` tool) through `motherDuckRunner`. The full record — the probes, the
   two protocols, and the alternatives if this is revisited — is duckdb-mosaic.md Part 4b, "The
   RUN_QUERY wedge".
6. **Array table names — ANSWERED: no.** mosaic-sql's `from()` qualifies an array, but a vgplot mark
   spreads it into three tables and cross-joins them. The bridge is a local view in the tab's
   catalog over the qualified name (copies nothing, pushes down); re-create it after a rebuild.
7. **Flock warm-up — two data points:** a Standard replica woke in 700 ms after a 6.5-minute idle;
   after a burst of sessions, a cold session took 34 s to open and the fourth session in a minute
   failed at the welcome pack with `UNAVAILABLE` (a throttle: a page opens one session).
8. **For a minter route: a token name is required and unique among LIVE tokens.** The OpenAPI spec
   marks `name` required (1–255 chars); a mint without one is 400; there is no anonymous or
   ephemeral credential (the Dive embed session is not a DuckDB token). A second mint under a
   live name is `409 CONFLICT`; revocation frees the name at once and expiry within minutes. A
   visitor's second tab is a second live token, so a route names `identity#mintTime`.

## 6. Decisions

1. Rotation never rebuilds the engine by itself (measured); grant TTL 1 h; a rebuild is explicit
   and app-timed, and `onRebuild` is where an app re-wires Mosaic and re-materializes.
2. The dev key's env var is `MOTHERDUCK_BROWSER_TOKEN`, a read-scaling token, never the admin PAT;
   it is opt-in in the vendor-key registry and reaches a page only under `vite serve`.
3. Per-identity `lanes` are a minter-side option, optional in every grant; the page never learns
   the account, the tier or the TTL.
4. The wasm ships with the app at the MotherDuck layout (`duckdbAssets`), never from a CDN;
   brotli-at-rest is the host's choice, and the plugin can emit the `.br` siblings.
5. Two runners on one engine — Mosaic raw, free-form SQL through the client's protocol — with the
   record and the alternatives written down (§5 item 5) rather than a guard or a rewrite now.
6. The lab stays out of the gallery (it needs a token) and is the reference for a consumer app.

## 7. What "done" looks like

A consumer app's `pnpm dev` shows a cloud table with a brush that re-queries locally; its published
page does the same with a token minted per visitor and attributed by name in MotherDuck's token
list and `QUERY_HISTORY`; no wasm is fetched from any third-party CDN; `pnpm evict:check`,
`test:packaging`, `skills:check` and CI stay green here and in the kit; the memory file
`motherduck-connector-assessment` is superseded by this document and duckdb-mosaic.md Part 4b.
