# DuckDB in the Browser: Parquet, Wasm, Quack, and Mosaic

A standalone reference for building browser applications on **DuckDB-Wasm**, with or
without [Mosaic](https://idl.uw.edu/mosaic/). Nothing here is specific to this repo — it
is the pattern, the code you always forget, and measured numbers for choosing between
the options.

**Everything below was measured, not recalled.** Machine: Apple Silicon, macOS,
Chrome 150 headless, all traffic over loopback — so network time is close to zero and the
numbers isolate *compute and volume*, not bandwidth. Date: 2026-07-28.

## The three shapes

| | where the bytes live | where the query runs | needs a server |
| --- | --- | --- | --- |
| **1 · Local Parquet** | fetched into the browser | in the tab (Wasm) | no — static hosting works |
| **2 · Served bytes** | on a server, fetched on demand | in the tab (Wasm) | a file server |
| **3 · Remote execution (Quack)** | stays on the server | on the server | a DuckDB process |

Shape 1 is the one you can deploy to S3 behind a CDN. Shape 3 is what you need when the
data outgrows a tab. Shape 2 is the awkward middle — **and Quack largely eliminates it**,
because a server that answers *queries* removes the need for one that serves *bytes*.

---

## Part 1 — Getting Parquet bytes into DuckDB-Wasm

The part everyone forgets. There are three ways, and they differ in who does the fetching.

### Boot, once

```ts
import * as duckdb from "@duckdb/duckdb-wasm";
// Vite `?url` imports make these first-class assets of YOUR app, served from your
// own origin. The alternative, duckdb.getJsDelivrBundles(), hits a CDN at runtime.
import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import ehWasm from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import mvpWasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";

const bundle = await duckdb.selectBundle({
  mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
  eh: { mainModule: ehWasm, mainWorker: ehWorker },
});
const worker = new Worker(bundle.mainWorker!, { type: "classic" });
const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
const conn = await db.connect();
```

**Ship `mvp` + `eh` only, not `coi`.** The `coi` (threaded) bundle needs `SharedArrayBuffer`,
which needs COOP/COEP response headers that static hosts generally cannot set.
`selectBundle` picks `eh` on every modern browser. Measured boot: **308–365 ms**.

### Way A — `registerFileURL`: DuckDB does the fetching

```ts
await db.registerFileURL("data.parquet", url, duckdb.DuckDBDataProtocol.HTTP, false);
const result = await conn.query(`SELECT * FROM read_parquet('data.parquet') LIMIT 10`);
```

### Way B — `registerFileBuffer`: you do the fetching

```ts
const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
await db.registerFileBuffer("data.parquet", buf);
const result = await conn.query(`SELECT * FROM read_parquet('data.parquet') LIMIT 10`);
```

Way B is measurably faster and lets you own progress reporting, retries, and caching.
Way A is one line.

### Way C — materialise into a table

```ts
await conn.query(`CREATE TABLE t AS SELECT * FROM read_parquet('data.parquet')`);
```

Costs memory but makes repeat queries fastest. Only worth it when you will query many times.

### Measured: load cost by file size

Query in all cases is a group-by aggregate returning 5 rows.

| Parquet (zstd) | rows | Way A total | bytes on the wire | Way B total (of which fetch) |
| --- | --- | --- | --- | --- |
| 1.9 MB | 300 K | 101 ms | 2.0 MB | **15 ms** (5 ms) |
| 18 MB | 3 M | 165 ms | 19.2 MB | **107 ms** (30 ms) |
| 73 MB | 12 M | 473 ms | 76.2 MB | **392 ms** (109 ms) |
| 272 MB | 45 M | 1514 ms | 285.5 MB | **1364 ms** (312 ms) |

### The fact that governs shape 1: **DuckDB-Wasm does not range-read**

My file server supported HTTP `Range` and advertised `accept-ranges: bytes`. Every load
above produced **exactly 1 HTTP request and 0 range requests**, transferring the whole
file — 285.5 MB fetched to answer a query that returns 5 rows.

This is the ceiling on shape 1. Over loopback, 272 MB costs 1.5 s. Over a 100 Mbit link it
is ~23 s, every cold load. Native DuckDB *does* range-read the same file; the Wasm build
does not. **Size your shape-1 datasets by what you are willing to download in full.**

Once loaded, local query speed is excellent — the same aggregate, warm:

| dataset | warm local query |
| --- | --- |
| 1.9 MB / 300 K rows | 10 ms |
| 18 MB / 3 M rows | 72 ms |
| 73 MB / 12 M rows | 273 ms |
| 272 MB / 45 M rows | 1031 ms |

---

## Part 2 — Quack: remote DuckDB over HTTP

[Quack](https://duckdb.org/docs/current/quack/overview) turns a DuckDB instance into an
HTTP server that other DuckDB instances connect to as clients. **DuckDB v1.5.3+.** It is
DuckDB's own remote protocol, which means the Wasm build is already a client — you do not
implement a wire format.

### The server

```js
import { DuckDBInstance } from "@duckdb/node-api";
const c = await (await DuckDBInstance.create(":memory:")).connect();
await c.run("INSTALL quack");
await c.run("LOAD quack");
await c.run(`CREATE VIEW events AS SELECT * FROM read_parquet('/data/events.parquet')`);
await c.runAndReadAll(
  `SELECT * FROM quack_serve('quack:0.0.0.0:9494',
     token => 'YOUR_TOKEN', disable_ssl => true, allow_other_hostname => true)`);
```

::: warning The listen address needs the `quack:` scheme
`quack_serve('0.0.0.0:9494')` fails with *"Invalid DuckDB Quack RPC URI, needs to start
with 'quack:'"*. Even for the address you are binding.
:::

### The client, in a browser

```ts
await conn.query("LOAD quack");                  // statically linked in Wasm — no INSTALL
const rows = await conn.query(
  `FROM quack_query('quack:localhost:9494',
     'SELECT project, count(*) FROM events GROUP BY 1',
     disable_ssl => true, token => 'YOUR_TOKEN')`);
```

### It works cross-origin with no configuration

The docs put nginx in front of Quack, which reads like CORS is a problem. It is not — the
reverse proxy is about TLS. Captured off the wire:

```
>>> POST /quack    content-type: application/octet-stream
<<< 200            content-type: application/vnd.duckdb
                   access-control-allow-origin: *
```

`application/octet-stream` makes this a CORS **simple request**, so **no preflight fires**,
and the response carries `ACAO: *`. Measured from a page on `:5175` to a server on `:9494`:
**works, 14 ms**. Through a same-origin proxy: 6 ms. Either is fine.

::: tip Do not probe `GET /` to test CORS
`GET /` returns a friendly text page (*"This is a DuckDB Quack RPC endpoint"*) with **no
CORS headers at all**. It is not the RPC endpoint. Probing it with curl says "no CORS
support" and is simply wrong. The endpoint is `POST /quack`.
:::

---

## Part 3 — `ATTACH` vs `quack_query`: the difference is enormous

Quack offers two client shapes. They look interchangeable. **They are not.**

```sql
-- (a) ATTACH: the remote catalog becomes addressable like a local schema
ATTACH 'quack:localhost:9494' AS remote (TOKEN '…', DISABLE_SSL true);
SELECT count(*) FROM remote.events;

-- (b) quack_query: SQL is sent as a string and executed on the server
FROM quack_query('quack:localhost:9494', 'SELECT count(*) FROM events',
                 disable_ssl => true, token => '…');
```

Measured against a **272 MB / 45 M-row** table, bytes counted by a proxy in front of the
server:

| query | time | bytes over the wire | RPC calls |
| --- | --- | --- | --- |
| `ATTACH` — group-by aggregate → 5 rows | 2683 ms | **5261.7 MB** | 1853 |
| `ATTACH` — `SELECT count(*)` → 1 row | 2677 ms | **5261.7 MB** | 1852 |
| `quack_query` — same aggregate | **29 ms** | **~0 MB** | 3 |
| `quack_query` — same count | **5 ms** | **~0 MB** | 3 |

**`ATTACH` performs no predicate, projection, or aggregate pushdown whatsoever.** A bare
`count(*)` drags the entire table across — the same 5.26 GB as the full aggregate. It is a
*remote table access* mechanism, not a *remote execution* one.

From the browser the same `ATTACH` aggregate took **30,987 ms** and moved 5.26 GB, because
the Wasm client also has to deserialise all of it.

Smaller tables at the same ratio:

| table | `ATTACH` | `quack_query` |
| --- | --- | --- |
| 18 MB / 3 M rows | 216 ms · 350.8 MB | 9 ms · ~0 MB |
| 73 MB / 12 M rows | 725 ms · 1403.1 MB | 12 ms · ~0 MB |
| 272 MB / 45 M rows | 2683 ms · 5261.7 MB | 29 ms · ~0 MB |

> **Rule:** use `ATTACH` only when you intend to pull the table. For anything that
> aggregates, filters, or counts, put the SQL inside `quack_query`.

### Session semantics: fresh session per call

`quack_query` opens a new session each call. This matters more than it sounds:

| | survives between calls? |
| --- | --- |
| `CREATE TEMP TABLE` | ❌ no — *"Table with name … does not exist"* |
| `CREATE TABLE` (regular) | ✅ yes |
| `SET` (global scope) | ✅ yes |

---

## Part 4 — Mosaic on top

### Wiring Mosaic to local Wasm (shape 1)

```ts
import { Coordinator, wasmConnector } from "@uwdata/mosaic-core";
import * as vg from "@uwdata/vgplot";

const coordinator = new Coordinator();
coordinator.databaseConnector(wasmConnector({ duckdb: db }));
const api = vg.createAPIContext({ coordinator });
```

### Wiring Mosaic to a Quack server (shape 3)

The whole trick: **Mosaic emits SQL; wrap it in `quack_query` so it executes remotely.**
Delegate to Mosaic's own `wasmConnector` and rewrite only the SQL — the Wasm instance
becomes a pure protocol client.

```ts
import { wasmConnector } from "@uwdata/mosaic-core";

function quackConnector(connection, uri, token) {
  const inner = wasmConnector({ connection });
  const wrap = (sql) =>
    `FROM quack_query('${uri}', $q$${sql}$q$, disable_ssl => true, token => '${token}')`;
  return { query: ({ type, sql }) => inner.query({ type, sql: wrap(sql) }) };
}

const coordinator = new Coordinator();
coordinator.databaseConnector(quackConnector(conn, "quack:localhost:9494", TOKEN));
```

::: danger Do not hand Mosaic duckdb-wasm's query result directly
`conn.query()` returns an **apache-arrow** table; Mosaic expects a **flechette** one and
fails with `data.toColumns is not a function`. `wasmConnector` handles the Arrow IPC decode
— delegating to it is why the four lines above work.
:::

The `$q$…$q$` dollar quoting matters: Mosaic's SQL is full of single quotes.

**Measured, live crossfilter chart (`rectY` + `bin` + `intervalX`) over the 272 MB remote table:**

| | result |
| --- | --- |
| chart render | **406 ms**, 24 marks |
| bytes to the browser | **~0 MB** |
| RPC calls | 12 |
| aggregate query | 51 ms |

Mosaic's pre-aggregation works over this, because `PreAggregator` creates its cube with
`{ temp: false }` — **regular** tables, which survive `quack_query`'s fresh sessions. Had it
used temp tables, this route would not work.

### Gotcha: Mosaic quotes dotted names as one identifier

`api.from("remote.events")` emits `FROM "remote.events"` — a single identifier — and dies:

```
Catalog Error: Table with name remote.events does not exist!
```

If you use the `ATTACH` route, bridge it with an unqualified local view (this copies nothing):

```sql
CREATE VIEW events AS SELECT * FROM remote.events;   -- then api.from("events")
```

### Driving the crossfilter programmatically — selection dimensions

Mouse interactors are not the only writers a Selection should have. The
`aiui-viz/mosaic-selection` subpath gives one logical filter the `control()`
treatment — declared in the store, compiler-named, validated once, durable,
and surfaced to agents as a real `set-<name>` tool (via `action()`, so the
standard tools, the page-tools relay, and the oracle all see a real JSON
Schema):

```ts
import { selectionDim, selectionSignal } from "@habemus-papadum/aiui-viz/mosaic-selection";

/** Magnitude window — the completeness bracket every view filters by. */
export const mag = selectionDim({
  scope: appScope,
  kind: "interval",
  targets: [{ selection: brush, field: "mag", table: "quakes" }],
  min: 0, max: 10,
});
mag.set({ lo: 5 });          // one-sided; publishes exactly like a brush drag
```

Setting a dimension publishes clauses with a stable per-(dimension, target)
source, so re-sets replace rather than stack — the same semantics as a
re-dragged brush. A dimension with several targets fans one semantic value
out as a table-appropriate clause per Selection ("time" as `epoch_ms(ts)` on
one table, `started_at` on another) — necessary because Mosaic itself routes
nothing: every clause reaches every filtered client verbatim, and a clause
naming a column a client's table lacks is a binder error Mosaic logs and
swallows. The read side is `selectionSignal(brush)` — a version counter over
the Selection's own value event, with reactive `clauses()`/`active()`/`sql()`
views that track *every* producer (mouse, menu, agent), not just dimensions.

The module docblock in `src/mosaic-selection.ts` carries the full contract
and the encoded gotchas (2×1-D over 2-D boxes, preagg vs. cross-table
clauses, report-after-a-task-boundary); `src/mosaic-selection.test.ts` pins
the behaviors against the real pinned mosaic-core.

---

## Part 5 — Choosing

| your situation | shape |
| --- | --- |
| Data < ~50 MB, want static hosting / offline | **1** — local Parquet, `registerFileBuffer` |
| Data too big to download, server available | **3** — Quack + `quackConnector` |
| Want both from one codebase | keep the connector behind one seam; the app's SQL is identical |

The last row is the payoff: shapes 1 and 3 differ **only** in which connector the
`Coordinator` is given. Application code, Mosaic specs, and SQL are unchanged.

And a hybrid the Quack route uniquely allows — because it is all one DuckDB, a single query
can mix a local table with a remote one:

```sql
SELECT l.label, r.n
FROM local_lookup l
JOIN (FROM quack_query('quack:host', 'SELECT project, count(*) n FROM events GROUP BY 1',
                       disable_ssl => true, token => '…')) r
  ON r.project = l.project
```

---

## Part 6 — Version matching is mandatory

Client and server must run the **same quack build**, not merely compatible DuckDB versions.

| build | DuckDB | quack |
| --- | --- | --- |
| `@duckdb/duckdb-wasm@1.33.1-dev61.0` | v1.5.4 | `40de7ba` |
| `@duckdb/duckdb-wasm@1.33.1-dev64.0` | v1.5.5 | `c154811` |
| `@duckdb/node-api@1.5.5-r.2` | v1.5.5 | `c154811` |

A `40de7ba` client against a `c154811` server returns simple results correctly and then, on
a mixed-type aggregate, fails with:

```
INTERNAL Error: Vector::Reference used on vector of different type
                (source VARCHAR referenced BIGINT)
```

**That error is fatal to the entire Wasm database**, not just the query. Everything after it
returns *"database has been invalidated because of a previous fatal error"*, and the only
recovery is constructing a new `AsyncDuckDB`. Budget for that in any long-lived page:
catch fatal errors and rebuild the instance.

Check what you have:

```sql
SELECT version();
SELECT extension_name, loaded, installed, extension_version
FROM duckdb_extensions() WHERE extension_name = 'quack';
```

In Wasm, quack reports `installed: false, loaded: true` — it is statically linked, so `LOAD`
works and `INSTALL` is unnecessary. Native builds need `INSTALL quack` first.

---

## Appendix — traps that cost real time

- **Vite's dep-optimizer cache survives a dependency version change.** After bumping
  `@duckdb/duckdb-wasm`, `db.instantiate()` hangs forever with no error, because optimised
  JS from the old version is being served against the new `.wasm`. Fix: `rm -rf
  node_modules/.vite` and restart.
- **A Vite `proxy` key is a prefix match.** A rule for `/quack` also captures `/quack.html`,
  so a page with that name 404s into the proxy. Name pages so they cannot collide.
- **DuckDB-Wasm runs in a Web Worker**, so CDP's `Network` domain on the *page* target sees
  none of its HTTP traffic. To count bytes, instrument the server or proxy — attaching to the
  worker target is fragile because a reload destroys it.
- **`SELECT … LIMIT 1` over `ATTACH` still moves megabytes** (2.87 MB measured) — `LIMIT`
  is not pushed down either.
- **Concurrency does not rescue the `ATTACH` route**: 8 parallel aggregates took 15.7 s via
  `ATTACH` versus 616 ms against a local table.
