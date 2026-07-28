# cc-miner

Your own Claude Code usage: cost per turn, where it goes, and whether a session was time well spent.

Wired to the workspace (`workspace:^`, no npm install of aiui packages, no build step), and staged
for eviction to its own repo — see [`scripts/evict.mjs`](../../scripts/evict.mjs). Its data comes
from [`cc-assay`](../cc-assay) next door.

## Two hosts, one app

cc-miner runs in a browser tab or in an Electron window. Both are **dev servers**: Electron is not
a different build, it is a different window pointed at an equivalent Vite server. There is no
packaging story yet — no DMG, no `app://`, no code signing.

```sh
pnpm serve           # terminal 1 — the DuckDB host (required; see below)
pnpm dev             # terminal 2 — browser host, http://localhost:5173
pnpm dev:electron    #     …or the Electron host, http://localhost:5179 in a window
pnpm claude          # terminal 3 — Claude Code with the aiui channel + session browser
```

## The DuckDB host

The app does **not** query Parquet in the tab. A native DuckDB process holds the
data and answers over [Quack](https://duckdb.org/docs/current/quack/overview),
DuckDB's own HTTP remote protocol; the page's duckdb-wasm is kept solely to speak
that protocol. Zero Parquet bytes reach the browser.

```sh
pnpm serve --flat                     # the legacy flat src/data layout
pnpm serve --data <dir>               # a Hive-partitioned corpus on disk
pnpm serve --s3-prefix s3://bucket/cc --s3-profile personal
```

It picks a free port, writes `.aiui-cache/duckdb-host.json`, and the Vite plugin
proxies `/quack` there — so **no port is ever hardcoded in the page**. Start
order does not matter: the runtime file is read per request, and the app says so
plainly if the host is not up.

Why not `ATTACH` the remote catalog and query it like a local table? Because
`ATTACH` does no pushdown at all — a bare `count(*)` over a 272 MB table moved
5.26 GB — while sending the SQL with `quack_query` answered it in 5 ms with ~0
bytes. See [the DuckDB guide](../../docs/guide/duckdb-mosaic).

The two can run at the same time; the Electron one suffixes its title with `· electron` so the
windows are tellable apart. `pnpm dev:electron` opens a Chrome DevTools Protocol port on **9333**
(not 9222 — that belongs to the shared aiui session browser), so the window can be driven and
inspected like any other Chromium.

The first `pnpm dev:electron` pauses to download Electron's ~200 MB platform binary. That is
lazy — electron@43 publishes no install script — so it happens on first run rather than at
`pnpm install`.

| | browser | Electron |
| --- | --- | --- |
| config | `vite.config.ts` | `vite.electron.config.ts` |
| shared | `vite.config.base.ts` | `vite.config.base.ts` |
| shell | `pnpm dev` | `electron/dev.mjs` → `electron/main.mjs` |

The renderer is identical in both — same bundle, same HMR, same DuckDB-WASM in-tab, same
`SharedArrayBuffer`-free `eh` bundle. Where it needs to know which shell it is in (today: the
title suffix, and nothing else) it asks at runtime, via [`src/host.ts`](./src/host.ts), rather
than through a build flag. Verified by measurement: with both servers up, the two render the same
52,516 characters of visible text, the same 62,290 SVG marks and the same 13 cells.

`electron/` is deliberately in-package for now. It moves to a shared package once the shape has
earned it.

## Open it in the shared browser

```sh
./aiui open http://localhost:5173   # from the repo root
```

Activate the intent client (**⌘B**) and describe what you want. See
[docs/guide/getting-started.md](../../docs/guide/getting-started.md).
