/**
 * store.ts — the durable roots of the lab, and the ONE thing the lab exists
 * to exercise: the in-tab MotherDuck engine as a durable island the rest of
 * an aiui app reaches through the same two seams as any DuckDB app —
 * Mosaic's coordinator (aiui-viz's `duckdbConnector`: the stock `wasmConnector`
 * plus HUGEINT decoded to numbers) and the agent's SQL runner.
 *
 * What the island holds, and what survives what:
 *
 *  - The ENGINE (`standardMotherDuckEngine`): under `vite serve` the aiui
 *    plugin seeds `MOTHERDUCK_BROWSER_TOKEN`; a pasted token from the shared
 *    key field takes precedence, including on a built page. Either way
 *    ONE stock `AsyncDuckDB` with the MotherDuck extension attached: the tab's
 *    `memory` catalog beside the cloud databases, one statement across both.
 *  - The wasm comes from THIS origin (`duckdbAssets: true` in vite.config.ts
 *    publishes it at the MotherDuck layout; `duckdbAssetsLocation()` reads
 *    the prefix back). No CDN.
 *  - A hot edit keeps all of it (this module is a durable root). A REBUILD
 *    (`rebuild()`: the engine's terminate + create with the source's current
 *    token) keeps nothing local — that is the measured cost the lab shows:
 *    the materialized sample vanishes, the cloud tables do not.
 *
 * The runner the agent's `sql`/`schema` tools hold is one stable object that
 * delegates to the CURRENT generation, so the tools never hold a dead
 * connection across a rebuild. It is the CLIENT's connection, not a raw one:
 * `MD_ALL_DATABASES()` through `connection.query()` (the blocking RUN_QUERY
 * protocol) wedges the whole engine, while the client's `send()`-based
 * `evaluateQuery` answers it (measured; the record is aiui-viz's
 * duckdb-mosaic.md Part 4b, "The RUN_QUERY wedge"), and the `sql` tool is
 * exactly where a model types that. Mosaic's connection stays raw — its
 * generated SQL never calls `md_*`.
 */
import {
  type MotherDuckEngine,
  type MotherDuckEngineHandle,
  motherDuckRunner,
  standardMotherDuckEngine,
} from "@habemus-papadum/aiui-cf-creds/motherduck";
import {
  type ControlBox,
  control,
  durableSignal,
  type SignalBox,
  scope,
} from "@habemus-papadum/aiui-viz";
import { crossfilter } from "@habemus-papadum/aiui-viz/crossfilter";
import {
  duckdbAssetsLocation,
  type SqlResult,
  type SqlRunner,
} from "@habemus-papadum/aiui-viz/duckdb";
import { duckdbConnector } from "@habemus-papadum/aiui-viz/mosaic-connector";
import { browserVendorKey } from "@habemus-papadum/aiui-viz/vendor-keys";
import { Coordinator, type Selection } from "@uwdata/mosaic-core";
import { type Accessor, createSignal } from "solid-js";
import type { TableRef } from "./catalog";

/** The app's instance scope — qualifies every declaration, names the toolkit. */
export const appScope = scope("motherduck-lab");

/** The lab's name at an optional broker. The gallery uses pasted/dev tokens. */
export const BROKER_GRANT_PATH = "motherduck-lab";

/** MotherDuck's public `sample_data` share — attached in single mode so the lab has tables to show. */
export const SAMPLE_DATA_SHARE = "md:_share/sample_data/23b0d623-1361-421d-ae77-62d701d471e6";

/**
 * How the engine attaches to MotherDuck — decided by the page URL, once, at
 * the durable root (a mode is fixed by the first connect; a change is a
 * reload): `?database=<name>` is SINGLE mode on that one database you own
 * (the docs' choice for apps and service accounts: the session touches no
 * saved workspace, and sees nothing else unless attached by hand — the lab
 * attaches the public sample_data share), no parameter is WORKSPACE mode
 * (every database saved in your workspace, the personal default).
 */
export interface AttachConfig {
  mode: "single" | "workspace";
  /** The one database, in single mode. */
  database?: string;
}

export function attachConfigFromUrl(search: string): AttachConfig {
  const database = new URLSearchParams(search).get("database")?.trim();
  return database !== undefined && database !== ""
    ? { mode: "single", database }
    : { mode: "workspace" };
}

export interface LabStore {
  engine: MotherDuckEngine;
  /** How the engine attached (see {@link attachConfigFromUrl}). */
  attach: AttachConfig;
  coordinator: Coordinator;
  /** The one cross-filter both histograms brush and filter by — aiui-viz's
   * routed one: a clause reaches a client only when its table has the
   * clause's columns, so a second table on the page needs no care. */
  brush: Selection;
  /** The engine generation the coordinator is wired to (0 until the first build). */
  generation: Accessor<number>;
  /** The current handle, wired (coordinator + runner) — builds on first call. */
  ready(): Promise<MotherDuckEngineHandle>;
  /** The agent's SQL runner: stable, delegating to the current generation. */
  sqlRunner: SqlRunner;
  /** Zero until a token is available or the user presses Connect; bump to retry. */
  connectAttempt: SignalBox<number>;
  connect(): void;
  /** The cloud (or local) table the histograms and the sample come from. */
  pick: SignalBox<TableRef | undefined>;
  /** The numeric column to bin and to range the hybrid question over. */
  column: SignalBox<string | undefined>;
  /** Rows to pull into the local sample. */
  sampleRows: ControlBox<number>;
  /** Bumps whenever the local sample may have changed (materialize, rebuild). */
  localVersion: Accessor<number>;
  bumpLocal(): void;
  /** Terminate + create with the source's current token; local tables are lost. */
  rebuild(reason: string): Promise<void>;
}

/** Where the plugin published the wasm — or, without the plugin, MotherDuck's CDN. */
function assetsPrefix(): string | undefined {
  try {
    return duckdbAssetsLocation().prefix;
  } catch (err) {
    console.warn(
      "[motherduck-lab] no self-hosted wasm; the client will use app.motherduck.com",
      err,
    );
    return undefined;
  }
}

export const store: LabStore = appScope.durable("store", () => {
  const prefix = assetsPrefix();
  const attach = attachConfigFromUrl(typeof location === "undefined" ? "" : location.search);
  const engine = standardMotherDuckEngine({
    grantPath: BROKER_GRANT_PATH,
    params: {
      sessionName: "motherduck-lab",
      customUserAgent: "aiui-motherduck-lab/0",
      ...(prefix !== undefined ? { duckDBAssetsURLPrefix: prefix } : {}),
      // single: the client only SETs motherduck_attach_mode, and its
      // "welcome pack" (PRAGMA MD_USE_DEFAULT: USE my_db) would fail with
      // nothing attached — the database itself is attached below, at
      // wiring (`databasePath` is the LOCAL DuckDB file path, not a
      // MotherDuck database).
      ...(attach.mode === "single" ? { attachMode: "single" as const, skipWelcomePack: true } : {}),
    },
  });
  const coordinator = new Coordinator();
  const brush = crossfilter();
  const [generation, setGeneration] = createSignal(0);
  const [localVersion, setLocalVersion] = createSignal(0);
  const bumpLocal = (): void => {
    setLocalVersion((v) => v + 1);
  };

  // The delegating runner: the tools hold THIS; `current` follows the generation.
  let current: SqlRunner | undefined;
  const runner: SqlRunner = {
    async query(sql, options): Promise<SqlResult> {
      await ready();
      if (current === undefined) {
        return Promise.reject(new Error("the MotherDuck engine is not built yet"));
      }
      return current.query(sql, options);
    },
    cancel: () => current?.cancel?.() ?? Promise.resolve(),
    // The schema views' DDL (graph.ts puts them in the tab's `memory`
    // catalog): forwarded, so the tools know this runner can hold a view.
    async exec(sql): Promise<void> {
      await ready();
      if (current?.exec === undefined) {
        return Promise.reject(new Error("the MotherDuck engine is not built yet"));
      }
      return current.exec(sql);
    },
  };

  // Wire one generation: a raw connection for Mosaic (through the decoding
  // connector — a brush's cube sums are HUGEINT, opaque bytes to flechette); the client's own
  // connection for the agent's reads (the md_* rule above).
  let wired = 0;
  let wiring: Promise<void> | undefined;
  const wire = (handle: MotherDuckEngineHandle): Promise<void> => {
    if (wired === handle.generation) return Promise.resolve();
    wiring ??= (async () => {
      const mosaicCon = await handle.connect();
      const agent = motherDuckRunner(handle.connection);
      // The tab's own catalog is CURRENT on every connection the lab holds:
      // the bridge views and the local sample are created and read
      // unqualified (Mosaic's marks cannot take a qualified name), and a
      // bare name never resolves across catalogs. Single mode may have
      // left the attached database current.
      await mosaicCon.query("USE memory");
      await agent.exec?.("USE memory");
      if (attach.mode === "single") {
        // The one database — ATTACH is engine-wide, so Mosaic's connection
        // sees it too — and, for something to look at beside it, the public
        // sample share (a share attaches by its URL in single mode).
        await agent.exec?.(`ATTACH IF NOT EXISTS 'md:${attach.database?.replaceAll("'", "''")}'`);
        await agent.exec?.(`ATTACH IF NOT EXISTS '${SAMPLE_DATA_SHARE}'`).catch((err) => {
          console.warn("[motherduck-lab] could not attach the sample_data share", err);
        });
      }
      coordinator.databaseConnector(duckdbConnector({ duckdb: handle.db, connection: mosaicCon }));
      current = agent;
      wired = handle.generation;
      setGeneration(handle.generation);
    })().finally(() => {
      wiring = undefined;
    });
    return wiring;
  };
  let readyTask: Promise<MotherDuckEngineHandle> | undefined;
  const ready = async (): Promise<MotherDuckEngineHandle> => {
    if (current === undefined && browserVendorKey("motherduck") === undefined) {
      throw new Error("Paste a MotherDuck read-scaling token, then connect.");
    }
    readyTask ??= (async () => {
      try {
        const handle = await engine.ready();
        await wire(handle);
        return handle;
      } catch (error) {
        // The kit caches failed builds too. Close before retrying with a corrected token.
        await engine.close();
        readyTask = undefined;
        throw error;
      }
    })();
    return readyTask;
  };

  /** Rows pulled into the local sample by `materialize`. */
  const sampleRows = control({
    scope: appScope,
    value: 50_000,
    min: 1_000,
    max: 1_000_000,
    step: 1_000,
    unit: "rows",
  });

  const connectAttempt = appScope.durableSignal(
    "connectAttempt",
    browserVendorKey("motherduck") ? 1 : 0,
  );
  return {
    engine,
    attach,
    coordinator,
    brush,
    generation,
    ready,
    sqlRunner: runner,
    connectAttempt,
    connect: () => connectAttempt.set(connectAttempt.get() + 1),
    pick: durableSignal<TableRef | undefined>(appScope.qualify("pick"), undefined),
    column: durableSignal<string | undefined>(appScope.qualify("column"), undefined),
    sampleRows,
    localVersion,
    bumpLocal,
    rebuild: async (reason) => {
      current = undefined;
      readyTask = (async () => {
        try {
          const handle = await engine.rebuild(reason);
          await wire(handle);
          bumpLocal();
          return handle;
        } catch (error) {
          await engine.close();
          readyTask = undefined;
          setGeneration(0);
          throw error;
        }
      })();
      await readyTask;
    },
  };
});
