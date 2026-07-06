/**
 * store.ts — the durable roots of the seismos page.
 *
 * These outlive every hot edit (design-choices §3): the DuckDB-WASM instance and
 * its two connections, the Mosaic coordinator wired to it, the registered
 * `quakes` table, the crossfilter `Selection` that every view shares, and the
 * user's controls (the completeness magnitude Mc). The cell graph (graph.ts) and
 * the components (ui/) are the disposable logic rebuilt over these — so an edit
 * to a chart spec or a cell never re-instantiates DuckDB or re-downloads the
 * 4 MB parquet, and never drops the current cross-filter selection.
 *
 * The async load (instantiate → fetch parquet with progress → CREATE TABLE →
 * summarize → connect the live histogram client) runs once, memoized behind
 * `ensureLoaded`. It is kicked off by the disposable loading cell, which forwards
 * its progress; on a hot reload the promise is already resolved, so the rebuilt
 * cell settles immediately against the surviving table.
 *
 * Level-1 notebook page (design-choices §8): its own entry/window, hence its own
 * durable registry and its own agent-tool namespace (window.__seismos).
 *
 * Why DuckDB is a durable island Mosaic reaches through a connector: Mosaic owns
 * its own reactivity (Selections → coordinator → client queries → SVG). Solid
 * never touches those internals — it renders the shells and reads the durable
 * signals below. The two systems meet only at the shared `Selection` and at the
 * histogram client's result signal. See NOTES.md.
 */
import type { AsyncDuckDB, AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { durable } from "@habemus-papadum/aiui-viz";
import { Coordinator, loadParquet, Selection, wasmConnector } from "@uwdata/vgplot";
import { type Accessor, createSignal, type Setter } from "solid-js";
import { fetchWithProgress, instantiateDuckDB } from "./duckdb";
import type { MagBin } from "./gr";
import { MagHistogramClient } from "./stats-client";

/** Base-aware URL of the bundled catalog (dev "/", build/preview "/aiui/"). */
const DATA_URL = `${import.meta.env.BASE_URL}data/quakes.parquet`;
/** Base-aware URL of the faint country-border overlay for the epicenter map. */
const WORLD_URL = `${import.meta.env.BASE_URL}data/countries-110m.geojson`;
const TABLE = "quakes";

/** The on-disk shape: antimeridian-split MultiLineString features (NOTES.md). */
interface BorderFeature {
  type: "Feature";
  properties: Record<string, never>;
  geometry: { type: "MultiLineString"; coordinates: [number, number][][] };
}

/**
 * One vertex of a country border, flattened for a vgplot `line` mark: raw
 * lon/lat — the exact coordinate space the epicenter raster lives in — with a
 * per-ring series id (`z` channel) so separate coastlines don't connect. Why a
 * line mark and not `geo`: vgplot's geo mark, fed these features as literal
 * client data on a projection-less plot, renders no mark group at all
 * (verified standalone); a line mark in plain x/y scale space aligns
 * pixel-for-pixel with the density image by construction. Preprocessed at
 * author time from Natural Earth 110m (see NOTES.md).
 */
export interface BorderPoint {
  /** Equal-Earth-projected vertex (see {@link equalEarth}). */
  x: number;
  y: number;
  /** Series id: one polyline ring per value. */
  ring: number;
}

/**
 * Equal Earth projection (Šavrič–Patterson–Jenny 2018), shared by the epicenter
 * map's layers. Equal-AREA — the right family for a density map (Mercator
 * inflates high latitudes and visually dilutes density there) — with a rounded,
 * Robinson-like silhouette and a native ~2.05:1 aspect. The projection is baked
 * into the DATA (eq_x/eq_y table columns, transformed border/graticule
 * vertices), not the plot: every layer stays in linear x/y space, the DuckDB
 * raster bins in projected (equal-area!) space, and the interval brush filters
 * on eq_x/eq_y — the on-screen rectangle IS the filtered region. Constants are
 * the published A1–A4; validated against the reference values (x_max 2.7066,
 * aspect 2.055).
 */
const EE_A1 = 1.340264;
const EE_A2 = -0.081106;
const EE_A3 = 0.000893;
const EE_A4 = 0.003796;
const EE_M = Math.sqrt(3) / 2;
export function equalEarth(lonDeg: number, latDeg: number): { x: number; y: number } {
  const lon = (lonDeg * Math.PI) / 180;
  const theta = Math.asin(EE_M * Math.sin((latDeg * Math.PI) / 180));
  const t2 = theta * theta;
  const t6 = t2 * t2 * t2;
  return {
    x:
      (lon * Math.cos(theta) * (2 * Math.sqrt(3))) /
      (3 * (EE_A1 + 3 * EE_A2 * t2 + t6 * (7 * EE_A3 + 9 * EE_A4 * t2))),
    y: theta * (EE_A1 + EE_A2 * t2 + t6 * (EE_A3 + EE_A4 * t2)),
  };
}
/** Projected extents: x at (±180°, 0°), y at the poles. */
export const EQ_X_MAX = equalEarth(180, 0).x;
export const EQ_Y_MAX = equalEarth(0, 90).y;

/** Default magnitude of completeness — global M4.5+ completeness sits near here. */
export const DEFAULT_MC = 4.7;
export const MC_MIN = 4.5;
export const MC_MAX = 6.5;

export type LoadState = "idle" | "loading" | "ready" | "error";

export interface Summary {
  rowsTotal: number;
  yearMin: number;
  yearMax: number;
  magMin: number;
  magMax: number;
  depthMin: number;
  depthMax: number;
}

export interface SeismosStore {
  coordinator: Coordinator;
  /** The one crossfilter selection every view publishes into and filters by. */
  brush: Selection;
  table: string;
  /** Completeness magnitude control (durable interaction state). */
  mc: { get: Accessor<number>; set: Setter<number> };
  loadState: Accessor<LoadState>;
  loadProgress: Accessor<number>;
  loadError: Accessor<unknown>;
  summary: Accessor<Summary | undefined>;
  /** Magnitude histogram of the current selection, kept live by the stats client. */
  histo: Accessor<MagBin[]>;
  /** Country borders for the map's faint overlay; empty until loaded (or if the
   *  optional overlay asset failed to fetch — the map still renders without it). */
  world: Accessor<BorderPoint[]>;
  /** Idempotent async load; forwards fraction-complete to `onProgress`. */
  ensureLoaded: (onProgress?: (fraction: number) => void) => Promise<Summary>;
  /** Bounded, read-only SELECT for the agent query tool (row-capped, sanitized). */
  runQuery: (sqlText: string, rowCap?: number) => Promise<Record<string, unknown>[]>;
}

function num(v: unknown): number {
  return typeof v === "bigint" ? Number(v) : Number(v);
}

/** Make an Arrow row JSON-safe: BigInt → number, Date/Timestamp → ISO string. */
function sanitize(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === "bigint") out[k] = Number(v);
    else if (v instanceof Date) out[k] = v.toISOString();
    else out[k] = v;
  }
  return out;
}

export const store: SeismosStore = durable("seismos:store", () => {
  const coordinator = new Coordinator();
  const brush = Selection.crossfilter();

  const [mcGet, mcSet] = createSignal(DEFAULT_MC);
  const [loadState, setLoadState] = createSignal<LoadState>("idle");
  const [loadProgress, setLoadProgress] = createSignal(0);
  const [loadError, setLoadError] = createSignal<unknown>(undefined);
  const [summary, setSummary] = createSignal<Summary | undefined>(undefined);
  const [histo, setHisto] = createSignal<MagBin[]>([]);
  const [world, setWorld] = createSignal<BorderPoint[]>([]);

  // A second connection dedicated to our own reads (summary + the agent query
  // tool), so they never contend with Mosaic's connection.
  let queryCon: AsyncDuckDBConnection | undefined;

  async function computeSummary(con: AsyncDuckDBConnection): Promise<Summary> {
    const t = await con.query(
      `SELECT count(*)::INT AS n,
              min(year)::INT AS y0, max(year)::INT AS y1,
              min(mag) AS magmin, max(mag) AS magmax,
              min(depth) AS dmin, max(depth) AS dmax
       FROM ${TABLE}`,
    );
    const r = t.toArray()[0] as Record<string, unknown>;
    return {
      rowsTotal: num(r.n),
      yearMin: num(r.y0),
      yearMax: num(r.y1),
      magMin: num(r.magmin),
      magMax: num(r.magmax),
      depthMin: num(r.dmin),
      depthMax: num(r.dmax),
    };
  }

  // The country overlay is optional chrome: fetch it alongside the parquet so it
  // adds no latency, and never let its failure abort the dataset load.
  async function fetchWorld(): Promise<BorderPoint[]> {
    const res = await fetch(WORLD_URL);
    if (!res.ok) throw new Error(`world overlay fetch failed: ${res.status}`);
    const gj = (await res.json()) as { features: BorderFeature[] };
    const points: BorderPoint[] = [];
    let ring = 0;
    for (const feature of gj.features) {
      for (const line of feature.geometry.coordinates) {
        for (const [lon, lat] of line) points.push({ ...equalEarth(lon, lat), ring });
        ring++;
      }
    }
    return points;
  }

  async function load(report: (fraction: number) => void): Promise<Summary> {
    const worldPromise = fetchWorld().catch((err) => {
      console.warn("[seismos] country overlay unavailable; map renders without it", err);
      return [] as BorderPoint[];
    });
    report(0.04);
    const db: AsyncDuckDB = await instantiateDuckDB();
    const mosaicCon = await db.connect();
    queryCon = await db.connect();
    // Hand Mosaic our locally-bundled instance (no jsDelivr): the connector uses
    // this connection for every view query.
    coordinator.databaseConnector(wasmConnector({ duckdb: db, connection: mosaicCon }));
    report(0.1);

    const buf = await fetchWithProgress(DATA_URL, (f) => report(0.1 + 0.8 * f));
    await db.registerFileBuffer("quakes.parquet", buf);
    // Materialize the parquet into a real table once (durable): views and our
    // own reads then hit an in-memory table, not the file each time.
    await queryCon.query(loadParquet(TABLE, "quakes.parquet").toString());
    // The map's projection columns (see equalEarth above): computed once at load
    // so the raster bins and the brush filter in projected space with linear
    // scales. Same polynomial as the JS mirror; theta staged in a subquery.
    await queryCon.query(
      `CREATE OR REPLACE TABLE ${TABLE} AS SELECT * EXCLUDE (ee_theta),
         RADIANS(longitude) * COS(ee_theta) * 1.1547005383792515
           / (1.340264 + 3*-0.081106*ee_theta*ee_theta
              + POWER(ee_theta, 6) * (7*0.000893 + 9*0.003796*ee_theta*ee_theta)) AS eq_x,
         ee_theta * (1.340264 + -0.081106*ee_theta*ee_theta
              + POWER(ee_theta, 6) * (0.000893 + 0.003796*ee_theta*ee_theta)) AS eq_y
       FROM (SELECT *, ASIN(0.8660254037844386 * SIN(RADIANS(latitude))) AS ee_theta FROM ${TABLE})`,
    );
    report(0.95);

    const s = await computeSummary(queryCon);

    // The live histogram of the current selection — a MosaicClient the
    // coordinator re-queries whenever the crossfilter changes.
    const client = new MagHistogramClient(TABLE, brush, setHisto);
    coordinator.connect(client);

    setWorld(await worldPromise);
    report(1);
    return s;
  }

  let loadPromise: Promise<Summary> | undefined;
  function ensureLoaded(onProgress: (fraction: number) => void = () => {}): Promise<Summary> {
    if (!loadPromise) {
      loadPromise = (async () => {
        // Detach from the loading cell's synchronous (owned) prologue before any
        // signal write — Solid 2.0 forbids owned-scope writes (hard-won §1).
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
          // Drop the memo so the loading cell's Retry re-attempts (otherwise
          // refetch would await the same rejected promise forever).
          loadPromise = undefined;
          throw err;
        }
      })();
    } else {
      // A later caller (e.g. a hot-rebuilt cell) still wants progress; the load
      // is done, so report complete.
      if (loadState() === "ready") onProgress(1);
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
    table: TABLE,
    mc: { get: mcGet, set: mcSet },
    loadState,
    loadProgress,
    loadError,
    summary,
    histo,
    world,
    ensureLoaded,
    runQuery,
  } satisfies SeismosStore;
});
