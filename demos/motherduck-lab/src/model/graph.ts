/**
 * graph.ts — the lab's cell graph (playbook layer 2) and its agent surface.
 *
 * Every cell reads through the store's delegating SQL runner, so every one of
 * them re-runs when the engine generation changes (a rebuild) — which is
 * exactly the event the lab wants to make visible: the session cell shows the
 * new generation, the tables cell still lists the cloud tables, and the local
 * cell reports the sample gone.
 *
 * The agent surface: the standard tools, the library's `sql` + `schema` over
 * the same runner (the table list introspected across EVERY attached catalog
 * — cloud and local alike), and four verbs: pick-table, pick-column,
 * materialize, rebuild-engine.
 */
import {
  action,
  agentToolkit,
  cell,
  hotCellGraph,
  registerStandardTools,
} from "@habemus-papadum/aiui-viz";
import { registerSqlTools, type SqlResult } from "@habemus-papadum/aiui-viz/duckdb";
import {
  createViewSql,
  hybridCountSql,
  isNumericType,
  isUserTable,
  LOCAL_COUNT_SQL,
  materializeSql,
  parseTableRefKey,
  type TableRef,
  type TableRow,
  tableRefKey,
  tableRefOf,
  viewNameFor,
} from "./catalog";
import { appScope, store } from "./store";

/** Rows as objects, the runner's columnar answer unpacked. */
function objects<T>(result: SqlResult): T[] {
  return result.rows.map(
    (row) => Object.fromEntries(row.map((v, i) => [result.columns[i], v])) as T,
  );
}

async function q<T>(sql: string): Promise<T[]> {
  return objects<T>(await (await store.sqlRunner).query(sql));
}

const num = (v: unknown): number => (typeof v === "bigint" ? Number(v) : Number(v));

export interface Session {
  username: string;
  version: string;
  generation: number;
  databases: Array<{ alias: string; type: string }>;
}

export interface ColumnInfo {
  name: string;
  type: string;
  numeric: boolean;
}

export interface LocalState {
  /** Rows in the local sample, or null when there is none (never made, or lost to a rebuild). */
  localRows: number | null;
  /** Cloud rows inside the sample's range of the picked column — the hybrid question. */
  hybridRows: number | null;
}

export const graph = hotCellGraph(
  appScope.name,
  () => ({
    /** Who the engine is connected as, on which DuckDB, with which databases attached. */
    session: cell(
      () => ({ generation: store.generation() }),
      async ({ generation }): Promise<Session> => {
        const [who, ver, dbs] = await Promise.all([
          q<{ username: string }>("SELECT username FROM md_user_info()"),
          q<{ v: string }>("SELECT version() AS v"),
          q<{ alias: string; type: string }>(
            "SELECT alias, type FROM MD_ALL_DATABASES() ORDER BY alias",
          ),
        ]);
        return {
          username: String(who[0]?.username ?? "?"),
          version: String(ver[0]?.v ?? "?"),
          generation,
          databases: dbs.map((d) => ({ alias: String(d.alias), type: String(d.type) })),
        };
      },
      { scope: appScope, name: "session" },
    ),
    /** Every user table across every attached catalog — cloud shares and the tab's own. */
    tables: cell(
      () => ({ generation: store.generation(), local: store.localVersion() }),
      async (): Promise<TableRef[]> => {
        const rows = await q<TableRow>(
          "SELECT table_catalog, table_schema, table_name, table_type FROM information_schema.tables " +
            "ORDER BY table_catalog, table_schema, table_name",
        );
        return rows.filter(isUserTable).map(tableRefOf);
      },
      { scope: appScope, name: "tables" },
    ),
    /** The local view over the picked cloud table — what the histograms read
     * (vgplot's marks can't take a qualified name; catalog.ts). Re-created
     * after a rebuild, since the tab's catalog is gone with the old engine. */
    view: cell(
      () => {
        const pick = store.pick.get();
        return pick === undefined ? undefined : { pick, generation: store.generation() };
      },
      async ({ pick }): Promise<string> => {
        await (await store.sqlRunner).query(createViewSql(pick));
        return viewNameFor(pick);
      },
      { scope: appScope, name: "view" },
    ),
    /** The picked table's columns, numeric ones flagged (the histograms bin those). */
    columns: cell(
      () => {
        const pick = store.pick.get();
        return pick === undefined ? undefined : { pick, generation: store.generation() };
      },
      async ({ pick }): Promise<ColumnInfo[]> => {
        const rows = await q<{ column_name: string; data_type: string }>(
          "SELECT column_name, data_type FROM information_schema.columns " +
            `WHERE table_catalog = '${pick.catalog}' AND table_schema = '${pick.schema}' ` +
            `AND table_name = '${pick.table}' ORDER BY ordinal_position`,
        );
        return rows.map((r) => ({
          name: String(r.column_name),
          type: String(r.data_type),
          numeric: isNumericType(String(r.data_type)),
        }));
      },
      { scope: appScope, name: "columns" },
    ),
    /** The local sample's state, and the hybrid count when a column is picked. */
    local: cell(
      () => ({
        version: store.localVersion(),
        generation: store.generation(),
        pick: store.pick.get(),
        column: store.column.get(),
      }),
      async ({ pick, column }): Promise<LocalState> => {
        let localRows: number | null;
        try {
          localRows = num((await q<{ n: unknown }>(LOCAL_COUNT_SQL))[0]?.n ?? 0);
        } catch {
          return { localRows: null, hybridRows: null }; // no such table: never made, or rebuilt away
        }
        if (pick === undefined || column === undefined) return { localRows, hybridRows: null };
        const hybrid = await q<{ n: unknown }>(hybridCountSql(pick, column));
        return { localRows, hybridRows: num(hybrid[0]?.n ?? 0) };
      },
      { scope: appScope, name: "local" },
    ),
  }),
  import.meta.hot,
);

export type AppGraph = ReturnType<typeof graph>;

// --- the agent surface -------------------------------------------------------

const kit = agentToolkit(appScope.name);
registerStandardTools(kit);
registerSqlTools(kit, { runner: store.sqlRunner });

/** Choose the table the histograms and the sample come from (`catalog.schema.table`). */
action({
  scope: appScope,
  name: "pick-table",
  inputSchema: {
    type: "object",
    properties: {
      table: { type: "string", description: "catalog.schema.table, as `tables` lists them" },
    },
    required: ["table"],
    additionalProperties: false,
  },
  run: (args) => {
    const ref = parseTableRefKey(String(args?.table ?? ""));
    if (ref === undefined) throw new Error("table must be catalog.schema.table");
    store.pick.set(ref);
    store.column.set(undefined);
    return { picked: tableRefKey(ref) };
  },
});

/** Choose the numeric column to bin and to range the hybrid question over. */
action({
  scope: appScope,
  name: "pick-column",
  inputSchema: {
    type: "object",
    properties: { column: { type: "string" } },
    required: ["column"],
    additionalProperties: false,
  },
  run: (args) => {
    const column = String(args?.column ?? "");
    if (column === "") throw new Error("column is required");
    store.column.set(column);
    return { picked: column };
  },
});

/** Pull the first `sampleRows` rows of the picked table into the tab's local sample. */
action({
  scope: appScope,
  name: "materialize",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  run: async () => {
    const pick = store.pick.get();
    if (pick === undefined) throw new Error("pick a table first");
    const rows = store.sampleRows.get();
    await (await store.sqlRunner).query(materializeSql(pick, rows));
    store.bumpLocal();
    return { table: tableRefKey(pick), rows };
  },
});

/** Terminate the engine and create it again with the source's current token — the local sample is lost, the cloud tables are not. */
action({
  scope: appScope,
  name: "rebuild-engine",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  run: async () => {
    await store.rebuild("agent");
    return { generation: store.engine.generation };
  },
});

kit.registerReporter("generation", () => store.generation());
kit.registerReporter("pick", () => {
  const pick = store.pick.get();
  return pick === undefined
    ? null
    : { table: tableRefKey(pick), column: store.column.get() ?? null };
});
