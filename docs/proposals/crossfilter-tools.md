# Cross-filter tools: one verb, a routed Selection, and views the agent can query

The Mosaic surface an agent drives, reorganized: one `cross-filter` tool for every declared
dimension, a cross-filter that routes clauses by column, the current subset as a view in the
database the `sql`/`schema` tools see, and a `group` on every tool.

Status: **SHIPPED 2026-10-09** on main, seismos as the reference. Every claim about Mosaic
below was read from the installed `@uwdata/mosaic-core@0.28.1` source; every DuckDB claim was
run in a scratch DuckDB before the design was accepted. The owner's decisions in the conversation
that led here: keep the `source` tool (it was already built); the word is *cross-filter*;
`reset-cross-filters` is its own tool; `sql` and `schema` must not depend on Mosaic — the
cross-filter contributes a *view* to the schema, like any other provider could; when a view
cannot be created, hand the agent the query text instead.

## 1. The shape before

Seismos registered 24 tools. Eight were `set-<dim>`, one per `selectionDim()` (the library's
derived action: a real schema each, but eight descriptions sharing one procedural tail), beside
`clear-selection { name }` (one filter), `clear-filters` (all), the four view verbs, `sql`,
`schema`, `suggest-mc`, and the seven standard tools. Four report sections described filtering.
The aggregate predicate existed in the page (`brushSignal.sql()`) but no tool returned it, and
`sql` queried the whole table. Within a namespace nothing classified a tool beyond `kind`.

Mosaic's multi-table story was fan-out: a dimension with one target per table, each a
table-appropriate field expression, usually into one Selection per table. A mouse brush on one
table's chart never reached another table, and a clause naming a column a client's table
lacks was a binder error Mosaic logged and swallowed while the chart froze.

## 2. What shipped

**A routed cross-filter** (`aiui-viz/crossfilter`, `crossfilter()`). Mosaic's one per-client
decision is `SelectionResolver.skip(client, clause)` — self-exclusion — and `Selection` takes
its resolver in the constructor. The routing resolver (built over a stock one by prototype,
since mosaic-core exports the class as a type only) adds one rule: skip when the clause's
columns (mosaic-sql's `collectColumns` over the predicate tree) are not all in the client's
table (`sourceTable()` on marks, `from` on inputs). Both `skip` and `predicate` are overridden,
because the stock `predicate` returns *no filter at all* when `skip(client, active)` — right
for the brushing chart, wrong for a client whose table merely lacks the active column, which
would then query unfiltered on connect; the early return stays on self-exclusion alone and
routing applies clause by clause. The pre-aggregator asks `skip` before materializing and
derives its non-active filter from `remove(source)`, a clone that keeps the resolver, so a
client the active clause cannot reach is skipped rather than re-queried. Columns come from the
schema (`columns`, `learnColumns`, or `describe`); until known, everything routes. A retraction
(null predicate) routes by the source's last column set. `exclude` names a column a table must
not take. Verified live on seismos (single-table: nothing changes on screen) and in
`crossfilter.test.ts` against the real pinned Selection.

**One tool** (`registerCrossfilterTools`): `cross-filter { set: { <dim>: value }, clear: [names] }`,
its schema a typed property per declared dimension (bounds, enums, unit, the doc comment),
re-rendered on `onSelectionDimsChange`; several dimensions in one call is one write; `clear`
takes dimensions or components (`clearSelectionFor`). `reset-cross-filters` clears every
dimension value and resets every target Selection (brushes, menus, include-relayed origins). The
`crossfilter` report section replaces the old four: predicate, per-table WHERE, view names,
dimensions, attributed clauses, capabilities. Results wait for the Selection's emits to quiesce
(400 ms for the first, 150 ms each after, 1.5 s at most) because a Selection's clause list is its
*emitted* state, which Mosaic emits after the coordinator's query batch.

**Schema views** (`aiui-viz/duckdb`): a `SchemaViewProvider` offers `{ schema, name, of, sql(),
describe() }` entries given the base tables and may `subscribe`; the SQL tools materialize each
as a real DuckDB view through the runner's new `exec` (`CREATE SCHEMA IF NOT EXISTS`,
`CREATE OR REPLACE VIEW`, metadata only), refresh lazily before the next call once a provider
signalled (DDL only when the body text changed), drop what a provider stops offering, list
them in `schema` with provenance (`views`, and `tables[].views`), name them in `sql`'s usage,
and attach a used view's provenance to a `sql` answer. `schemaOf` now names a table outside
`main` as `schema.name`. The cross-filter's provider (`crossfilterViews`) offers
`crossfilter.<table>` per covered table and teaches the router the columns; seismos adds
`complete.quakes` from the `mc` control — a provider owing Mosaic nothing, which is the point.
Without `exec` (a fresh-session connector; a remote database that must not be written) the
views are reported by body text, `materialized: false`. `viewCatalog` targets a named catalog
for the MotherDuck case, unverified on that client.

**`group`** on every tool, carried by the toolkit, the registry, the intent client's relays,
the channel's descriptors, the oracle and live projections, and the brief (sub-headings inside
the read/write sections). `app` (report, set, locate, actions by default), `page`, `sql`,
`crossfilter`, `views`. `toolsFromAiuiRegistry({ groups, excludeGroups })` is the per-scenario
switch; namespaces stay the per-app-instance unit. Seismos is at 16 tools.

**Clean-ups on the way**: the producer registry records each producer's tables; learning a
table's columns warns about a dimension whose column is missing there; the dimension module's
doc describes routing instead of fan-out-only; `selectionDimTargets` reads names without
values (reading a dimension's box right after another's write in the same tick trips the
staged-write guard — found live).

## 3. Facts the design rests on (verified)

- DuckDB: a CTE may shadow a base table while its body reads that table; a view in a second
  schema reads `main` and lists in `information_schema` as VIEW; a second connection sees it;
  200 `CREATE OR REPLACE VIEW` take 12 ms; schemas cannot be created in the temp catalog.
- DuckDB: a view body's bare table name binds to the view itself when the view carries that
  name — `"main"."quakes"` it must be (found live; `baseTableRef`).
- Mosaic 0.28: `MosaicClient.requestQuery`, `Coordinator.updateSelection` and
  `PreAggregator.request` are the three consumers of a Selection's resolution; `remove(source)`
  clones with the resolver; `queueFilter` coalesces queued emits by source.

## 4. Follow-ups, not taken

- motherduck-lab still builds its brush with `Selection.crossfilter()` and registers no views;
  the `viewCatalog: "memory"` path needs a run against the MotherDuck client.
- The SelectionInspector's `<For>` rows are fresh objects on every update (Solid's
  `UNSTABLE_LIST_IDENTITY` warning, pre-existing); key them.
- The published gallery runs the previous surface until the next release's site publish.
