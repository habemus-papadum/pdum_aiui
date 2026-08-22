/**
 * store.ts — the durable roots of the wine page (playbook layer 2, state
 * side), the seismos shape: the DuckDB-WASM instance and its two connections,
 * the Mosaic coordinator, the `wine` table, the crossfilter Selection every
 * view shares, the declared filter dimensions, and the component bindings.
 * The cell graph (graph.ts) and the components (ui/) are disposable logic
 * rebuilt over these — a hot edit never re-downloads 64 MB of parquet or
 * drops the current cross-filter.
 *
 * The embedding view is one more producer into the same brush: its `filter`
 * prop is the crossfilter (so histogram brushes and menu picks re-query the
 * point cloud) and its rectangle/lasso publishes INTO the crossfilter (so a
 * region on the map narrows every histogram). The projx/projy dimension pair
 * adopts it through the region facet binding — `set-projx`/`set-projy` draw
 * the on-map box, and a mouse lasso mirrors its bounding box back into the
 * dims (the clause keeps the exact polygon).
 *
 * The GEOGRAPHIC map is the second big view, the seismos pattern verbatim:
 * each review geocodes to its (country, province) centroid through the
 * curated lookup in src/data/provinces.json (Natural Earth admin-1 centroids
 * + hand-placed wine regions + country fallbacks; 97.5% of reviews at
 * region precision), jittered deterministically so provinces read as clouds,
 * projected to Equal-Earth eq_x/eq_y at load. Its 2-D brush publishes into
 * the same crossfilter, and the lon/lat dimension pair adopts it — lasso the
 * embedding and the map shows WHERE those wines come from; box a region and
 * the embedding shows what it tastes like.
 */
import type { AsyncDuckDB, AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { scope } from "@habemus-papadum/aiui-viz";
import {
  bindSelectionComponents,
  categorySelection,
  type IntervalValue,
  type PointValue,
  resetSelectionDimTargets,
  type SelectionDim,
  type SelectionSignal,
  selectionDim,
  selectionSignal,
} from "@habemus-papadum/aiui-viz/mosaic-selection";
import {
  type SelectionViewsStore,
  selectionViews,
} from "@habemus-papadum/aiui-viz/selection-views";
import { Coordinator, Selection, wasmConnector } from "@uwdata/mosaic-core";
import { type Accessor, createSignal } from "solid-js";
// Bundled assets (NOT public/ fetches): they travel with the package into
// any consumer's build. countries-110m is the same Natural Earth border
// overlay seismos preprocessed (antimeridian-split MultiLineStrings).
import worldUrl from "../data/countries-110m.geojson?url";
import provincesUrl from "../data/provinces.json?url";
import { BUNDLES, instantiateDuckDB } from "../duckdb";
import {
  classifySql,
  geoSql,
  joinSql,
  PROJECTION_MB,
  PROJECTION_URL,
  PROVINCE_GEO_SQL,
  REVIEWS_MB,
  REVIEWS_URL,
  TOP_VARIETIES_SQL,
} from "./data";
import { fetchDataCached } from "./fetch-cache";
import { degreesToEqBox, eqBoxToDegrees, equalEarth } from "./geo";
import { dimsToRect, rectToDims, setProjExtent } from "./region";
import { type SelectionStats, SelectionStatsClient } from "./stats-client";

const TABLE = "wine";

/** The demo's instance scope: ONE slug qualifying every declaration —
 * controls, durables, cells, actions, the graph key, and the toolkit
 * namespace (window.__wine). New declarations MUST thread it. */
export const appScope = scope("wine");

export type LoadState = "idle" | "loading" | "ready" | "error";

/** The on-disk border shape: antimeridian-split MultiLineString features. */
interface BorderFeature {
  type: "Feature";
  properties: Record<string, never>;
  geometry: { type: "MultiLineString"; coordinates: [number, number][][] };
}

/** One Equal-Earth-projected border vertex for a vgplot `line` mark, with a
 * per-ring series id so separate coastlines don't connect (seismos pattern —
 * a `geo` mark on a projection-less plot silently renders nothing). */
export interface BorderPoint {
  x: number;
  y: number;
  ring: number;
}

export interface Summary {
  rowsTotal: number;
  pointsMin: number;
  pointsMax: number;
  priceMin: number;
  priceMax: number;
  /** Category order: top-9 varieties by review count, then "other". */
  varieties: string[];
}

/** The declared filter dimensions — the named, validated, tool-surfaced
 * writers over the crossfilter (mouse producers publish into the same brush). */
export interface WineDims {
  points: SelectionDim<IntervalValue>;
  price: SelectionDim<IntervalValue>;
  country: SelectionDim<PointValue>;
  variety: SelectionDim<PointValue>;
  projx: SelectionDim<IntervalValue>;
  projy: SelectionDim<IntervalValue>;
  lon: SelectionDim<IntervalValue>;
  lat: SelectionDim<IntervalValue>;
}

export interface WineStore {
  coordinator: Coordinator;
  /** The one crossfilter selection every view filters by. */
  brush: Selection;
  /** The variety bar's own origin selection (categorySelection), so its
   * highlight can gray unselected varieties; include-relayed into `brush`. */
  varietySel: Selection;
  /** Reactive window onto the brush (every producer: dims, brushes, lasso). */
  brushSignal: SelectionSignal;
  dims: WineDims;
  /** Named cross-filter views (localStorage; save/load/list/delete-view tools). */
  views: SelectionViewsStore;
  /** Clear EVERY crossfilter clause; returns the count still visible. */
  clearFilters(): number;
  table: string;
  loadState: Accessor<LoadState>;
  loadProgress: Accessor<number>;
  loadError: Accessor<unknown>;
  summary: Accessor<Summary | undefined>;
  /** Live headline stats of the current selection (the stats client). */
  stats: Accessor<SelectionStats | undefined>;
  /** Country borders for the map's faint overlay; empty until loaded (or if
   * the optional asset failed — the map still renders without it). */
  world: Accessor<BorderPoint[]>;
  /** Idempotent async load; forwards fraction-complete to `onProgress`. */
  ensureLoaded: (onProgress?: (fraction: number) => void) => Promise<Summary>;
  /** Bounded, read-only SELECT for the agent query tool. */
  runQuery: (sqlText: string, rowCap?: number) => Promise<Record<string, unknown>[]>;
}

/** Make an Arrow row JSON-safe: BigInt → number, Date → ISO string. */
function sanitize(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === "bigint") out[k] = Number(v);
    else if (v instanceof Date) out[k] = v.toISOString();
    else out[k] = v;
  }
  return out;
}

const num = (v: unknown): number => (typeof v === "bigint" ? Number(v) : Number(v));

export const store: WineStore = appScope.durable("store", () => {
  const coordinator = new Coordinator();
  // The variety bar's origin, minted BEFORE the crossfilter so the include
  // relay is wired at construction (categorySelection's docblock).
  const varietySel = categorySelection();
  const brush = Selection.crossfilter({ include: [varietySel] });
  const brushSignal = selectionSignal(brush);

  // ---- the filter dimensions: declared writers over the shared brush -------

  /** Critic score window (WineEnthusiast points, 80–100). */
  const points = selectionDim({
    scope: appScope,
    kind: "interval",
    min: 80,
    max: 100,
    targets: [{ selection: brush, field: "points", table: TABLE }],
  });
  /** Bottle price window, US dollars (the catalog spans $4–$3300). */
  const price = selectionDim({
    scope: appScope,
    kind: "interval",
    min: 0,
    max: 5000,
    unit: "$",
    targets: [{ selection: brush, field: "price", table: TABLE }],
  });
  /** Country of origin — e.g. "US", "France", "Italy". */
  const country = selectionDim({
    scope: appScope,
    kind: "point",
    targets: [{ selection: brush, field: "country", table: TABLE }],
  });
  /** Grape variety class — the top-9 varieties by review count, or "other".
   * Targets the bar's ORIGIN selection so adoption publishes where the
   * toggle publishes; the include relay carries it into the brush. */
  const variety = selectionDim({
    scope: appScope,
    kind: "point",
    targets: [{ selection: varietySel, field: "variety_class", table: TABLE }],
  });
  /** Embedding-map x window (projection units) — with projy, the region box
   * on the tasting-note map; set both to draw a rectangle there. */
  const projx = selectionDim({
    scope: appScope,
    kind: "interval",
    targets: [{ selection: brush, field: "projection_x", table: TABLE }],
  });
  /** Embedding-map y window (projection units) — see projx. */
  const projy = selectionDim({
    scope: appScope,
    kind: "interval",
    targets: [{ selection: brush, field: "projection_y", table: TABLE }],
  });
  /** Longitude window, degrees east — pair with lat for a geographic box on
   * the world map (two 1-D clauses; a 2-D clause would not propagate). */
  const lon = selectionDim({
    scope: appScope,
    kind: "interval",
    min: -180,
    max: 180,
    unit: "°",
    targets: [{ selection: brush, field: "longitude", table: TABLE }],
  });
  /** Latitude window, degrees north. */
  const lat = selectionDim({
    scope: appScope,
    kind: "interval",
    min: -90,
    max: 90,
    unit: "°",
    targets: [{ selection: brush, field: "latitude", table: TABLE }],
  });
  const dims: WineDims = { points, price, country, variety, projx, projy, lon, lat };

  // Component adoption: writes route through each on-screen component's own
  // publish path (one clause per filter, the component's source and clients),
  // and mouse gestures mirror back into the dims. Producer names come from
  // the MosaicView/EmbeddingView `name` props and the menu registration.
  bindSelectionComponents({
    bindings: [
      { dim: points, producer: "wine/points-hist" },
      { dim: price, producer: "wine/price-hist" },
      { dim: country, producer: "wine/country-menu" },
      { dim: variety, producer: "wine/variety-bar" },
      { dims: [projx, projy], producer: "wine/embedding", to: dimsToRect, from: rectToDims },
      { dims: [lon, lat], producer: "wine/map", to: degreesToEqBox, from: eqBoxToDegrees },
    ],
  });

  // Named views over the dims (localStorage) + their four agent actions.
  const views = selectionViews({ scope: appScope });

  function clearFilters(): number {
    // One reset per unique dim-target Selection — the brush AND the variety
    // origin, which the brush's own reset cannot reach (one-way relay).
    resetSelectionDimTargets(appScope);
    return brush.clauses.length;
  }

  const [loadState, setLoadState] = createSignal<LoadState>("idle");
  const [loadProgress, setLoadProgress] = createSignal(0);
  const [loadError, setLoadError] = createSignal<unknown>(undefined);
  const [summary, setSummary] = createSignal<Summary | undefined>(undefined);
  const [stats, setStats] = createSignal<SelectionStats | undefined>(undefined);
  const [world, setWorld] = createSignal<BorderPoint[]>([]);

  // A second connection for our own reads (summary + the agent query tool),
  // so they never contend with Mosaic's connection.
  let queryCon: AsyncDuckDBConnection | undefined;

  // The border overlay is optional chrome: fetched alongside the parquets,
  // never allowed to abort the dataset load.
  async function fetchWorld(): Promise<BorderPoint[]> {
    const res = await fetch(worldUrl);
    if (!res.ok) throw new Error(`world overlay fetch failed: ${res.status}`);
    const gj = (await res.json()) as { features: BorderFeature[] };
    const points: BorderPoint[] = [];
    let ring = 0;
    for (const feature of gj.features) {
      for (const line of feature.geometry.coordinates) {
        for (const [lo, la] of line) points.push({ ...equalEarth(lo, la), ring });
        ring++;
      }
    }
    return points;
  }

  async function load(report: (fraction: number) => void): Promise<Summary> {
    // Both parquets in parallel, progress weighted by size; cached in the
    // Cache API so only the first visit downloads.
    const w = REVIEWS_MB + PROJECTION_MB;
    const parts = [0, 0];
    const combined = () => (parts[0] * REVIEWS_MB + parts[1] * PROJECTION_MB) / w;
    const part = (i: number) => (f: number) => {
      parts[i] = f;
      report(0.02 + 0.68 * combined());
    };
    const worldPromise = fetchWorld().catch((err) => {
      console.warn("[wine] country overlay unavailable; map renders without it", err);
      return [] as BorderPoint[];
    });
    const provincesPromise = fetch(provincesUrl).then((r) => r.arrayBuffer());
    const [reviews, projection, provinces] = await Promise.all([
      fetchDataCached(REVIEWS_URL, part(0)),
      fetchDataCached(PROJECTION_URL, part(1)),
      provincesPromise,
    ]);

    const db: AsyncDuckDB = await instantiateDuckDB(BUNDLES);
    const mosaicCon = await db.connect();
    queryCon = await db.connect();
    coordinator.databaseConnector(wasmConnector({ duckdb: db, connection: mosaicCon }));
    report(0.75);

    await db.registerFileBuffer("dataset.parquet", reviews);
    await db.registerFileBuffer("precomputed.parquet", projection);
    await queryCon.query(joinSql(TABLE));
    report(0.86);
    const tops = (await queryCon.query(TOP_VARIETIES_SQL(TABLE))).toArray() as {
      variety: string;
    }[];
    const topVarieties = tops.map((t) => String(t.variety));
    await queryCon.query(classifySql(TABLE, topVarieties));
    await queryCon.query(`DROP TABLE ${TABLE}_raw`);
    // The geographic columns: province centroids + per-row jitter + the baked
    // Equal-Earth projection (data.ts geoSql).
    await db.registerFileBuffer("provinces.json", new Uint8Array(provinces));
    await queryCon.query(PROVINCE_GEO_SQL);
    await queryCon.query(geoSql(TABLE));
    await db.dropFile("dataset.parquet");
    await db.dropFile("precomputed.parquet");
    await db.dropFile("provinces.json");
    report(0.95);

    const s = (
      await queryCon.query(
        `SELECT count(*)::INT AS n,
                min(points)::INT AS p0, max(points)::INT AS p1,
                min(price) AS pr0, max(price) AS pr1,
                min(projection_x) AS x0, max(projection_x) AS x1,
                min(projection_y) AS y0, max(projection_y) AS y1
         FROM ${TABLE}`,
      )
    ).toArray()[0] as Record<string, unknown>;
    setProjExtent({ xMin: num(s.x0), xMax: num(s.x1), yMin: num(s.y0), yMax: num(s.y1) });

    // The live headline numbers of the selection — re-queried by the
    // coordinator on every crossfilter change.
    coordinator.connect(new SelectionStatsClient(TABLE, brush, setStats));

    setWorld(await worldPromise);
    report(1);
    return {
      rowsTotal: num(s.n),
      pointsMin: num(s.p0),
      pointsMax: num(s.p1),
      priceMin: num(s.pr0),
      priceMax: num(s.pr1),
      varieties: [...topVarieties, "other"],
    };
  }

  let loadPromise: Promise<Summary> | undefined;
  function ensureLoaded(onProgress: (fraction: number) => void = () => {}): Promise<Summary> {
    if (!loadPromise) {
      loadPromise = (async () => {
        // Detach from the loading cell's owned prologue before signal writes.
        await Promise.resolve();
        setLoadState("loading");
        try {
          const s = await load((f) => {
            setLoadProgress(f);
            onProgress(f);
          });
          setSummary(s);
          setLoadState("ready");
          return s;
        } catch (err) {
          setLoadError(err);
          setLoadState("error");
          loadPromise = undefined; // let the cell's Retry re-attempt
          throw err;
        }
      })();
    } else if (loadState() === "ready") {
      onProgress(1);
    }
    return loadPromise;
  }

  async function runQuery(sqlText: string, rowCap = 1000): Promise<Record<string, unknown>[]> {
    if (!queryCon) throw new Error("dataset not loaded yet");
    const trimmed = sqlText.trim().replace(/;\s*$/, "");
    if (!/^(select|with)\b/i.test(trimmed)) {
      throw new Error("only read-only SELECT/WITH queries are allowed");
    }
    if (trimmed.includes(";")) throw new Error("multiple statements are not allowed");
    const cap = Math.max(1, Math.min(5000, Math.floor(rowCap)));
    const t = await queryCon.query(`SELECT * FROM (${trimmed}) AS _q LIMIT ${cap}`);
    return t.toArray().map((r) => sanitize(r as Record<string, unknown>));
  }

  return {
    coordinator,
    brush,
    varietySel,
    brushSignal,
    dims,
    views,
    clearFilters,
    table: TABLE,
    loadState,
    loadProgress,
    loadError,
    summary,
    stats,
    world,
    ensureLoaded,
    runQuery,
  } satisfies WineStore;
});
