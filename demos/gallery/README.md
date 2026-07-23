# demo: gallery

The notebook site's **shell**: an SPA that discovers the sibling demo packages
and composes them into one dark journal — a **landing page** (a card per demo,
each with a live preview) plus a left **sidebar** (collapsing to a top bar +
drawer on a phone). The dev playground for the whole demo set, and the source of
the published static site at <https://habemus-papadum.net/aiui/>.

The notebooks themselves live in their own packages (the demo-package dual
shape — see the root `CLAUDE.md`, "In-repo demo apps"):

| tab | package | what it is |
| --- | --- | --- |
| morphogen | [`demos/morphogen`](../morphogen) | Gray-Scott reaction–diffusion: WebGL sim island, worker analysis, history ring |
| aztec | [`demos/aztec`](../aztec) | random domino tilings: streaming shuffle worker, scrub ring, arctic circle |
| seismos | [`demos/seismos`](../seismos) | earthquakes & Gutenberg–Richter: DuckDB-WASM + Mosaic crossfilter |
| circle | [`demos/circle`](../circle) | how round can you draw a circle? the pencil-package demo |
| gears | [`demos/gears`](../gears) | involute spur gears in kinematic mesh (pure SVG geometry) |

**Discovery is marker-driven, not registered.** `demo-discovery.ts` (a Vite
plugin) scans `demos/*/package.json` for the `aiui.sitePage` marker, resolves
each demo's `./page` AND `./card` exports to real files, and serves
`virtual:demo-pages`; the sidebar items, the routes, and the lazy page + card
loaders (`src/site/`) all derive from it. The gallery's `package.json` deliberately does **not** depend on the
demos. A new demo appears by carrying the marker (a fresh `pnpm new-demo`
scaffold already does); restart the dev server to pick up a brand-new
directory.

The site home is a **landing** page (`src/site/Landing.tsx`): a card per demo,
each mounting the demo's own live `DemoCard.Preview` (lazily imported, so the
landing never boots a demo's heavy graph). Every page is an aiui-viz
**`SitePage`** (title, App, activate/deactivate).
Route changes are pause-not-destroy: the leaving page's components are
disposed, its rAF loops parked, while every durable — the WebGL field, the
workers, DuckDB, the history rings — survives for the return visit. All
navigation is client-side (`src/site/router.ts`), so an open intent turn rides
across notebook switches. The shared dark-journal look (tokens, notebook
chrome, chart palette) is [`demos/journal`](../journal).

[PRINCIPLES.md](./PRINCIPLES.md) is the methodology written while these
notebooks were built — read it next to the demo packages' code.

## Run it

```sh
# terminal 1 — a Claude Code session with the channel attached
./aiui claude

# terminal 2 — this shell, served by plain vite (the intent client finds the channel itself)
pnpm demo
```

Open the printed URL **in the session browser**. Each demo also runs
standalone from its own directory (`pnpm -C demos/<slug> dev`) with the same
loop.

## Publishing the static site

`pnpm run publish` (from this demo) builds the site (base `/aiui/`) and
dry-runs an `aws s3 sync` to `s3://habemus-papadum.net/aiui`; add `--publish`
(or `PUBLISH=1`) to upload for real and invalidate the CloudFront cache. The
SPA deep-link routes are derived from the same `aiui.sitePage` markers the
shell reads. Uses the `personal` AWS profile (override with `AWS_PROFILE`).
Note it must be `pnpm run publish` — bare `pnpm publish` is the npm registry
command, which this private package refuses. See [PUBLISHING.md](./PUBLISHING.md).
