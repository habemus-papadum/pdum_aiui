/**
 * graph.ts — the cell graph (playbook layer 2): every dataflow in the app,
 * notebook-style, plus the agent tool surface. Cells wrap the pure functions
 * of layer 1 with reality — time, failure, cancellation, streaming.
 *
 * This module is *disposable logic*. `hotCellGraph` builds the graph from the
 * durable roots in store.ts and, on a hot edit, disposes the old graph and
 * swaps in a new one — the sliders keep their positions and every cell
 * recomputes from the roots. Components read `graph().someCell` through the
 * stable accessor it returns, so they can never hold a stale cell reference.
 *
 * Add your cells inside the builder — `cell(deps, compute)` handles aborts,
 * progress, and streaming — and test them headless with
 * @habemus-papadum/aiui-viz/testing (one `whenReady` probe per input).
 */
import {
  action,
  agentToolkit,
  cell,
  hotCellGraph,
  registerStandardTools,
} from "@habemus-papadum/aiui-viz";
import { appScope, idleGapMinutes, store } from "./store";

/** One row of the "where did the money go" breakdown. */
export interface CostSlice {
  key: string;
  cost: number;
  turns: number;
}

/** A session as the timeline view needs it: wall-clock vs work. */
export interface SessionShape {
  sessionId: string;
  project: string;
  slug: string | null;
  firstTs: number;
  lastTs: number;
  spanSeconds: number;
  activeSeconds: number;
  dutyCycle: number;
  nTurns: number;
  nCompactions: number;
  peakContextTokens: number;
  cost: number;
}

// --- the graph: rebuilt over the durable roots on every hot edit --------------

/** The current graph — a stable accessor that survives hot swaps. */
export const graph = hotCellGraph(
  appScope.name,
  () => ({
    /**
     * The loading cell. It exists so the load is driven by the GRAPH, not by a
     * component: `ensureLoaded` writes its first progress signal synchronously,
     * and Solid 2.0 rejects a reactive write inside an owned scope
     * (REACTIVE_WRITE_IN_OWNED_SCOPE) — which is exactly what calling it from
     * a component body does. Same reason seismos drives its catalog from a cell.
     */
    dataset: cell(
      () => ({}),
      async () => {
        await store.ensureLoaded();
        return store.summary();
      },
      { scope: appScope },
    ),

    /**
     * Spend per day per project — the entry-point series. Kept as a cell rather
     * than a Mosaic client because the summary strip and the agent tools read
     * the same numbers, and one SQL round-trip is cheaper than three.
     */
    dailyCost: cell(
      () => ({}),
      async () =>
        store.sql<{ day: number; project: string; cost: number; turns: number }>(`
          SELECT epoch_ms(date_trunc('day', ts)) AS day,
                 project,
                 sum(costTotal)                  AS cost,
                 count(*)                        AS turns
          FROM turns
          GROUP BY 1, 2
          ORDER BY 1
        `),
      { scope: appScope },
    ),

    /**
     * The headline finding, per project: what fraction of spend is context
     * re-transmission rather than generation. Cache reads dominate, and this is
     * the cell that makes that visible.
     */
    tokenClasses: cell(
      () => ({}),
      async () =>
        store.sql<
          CostSlice & { cacheRead: number; cacheCreate: number; output: number; input: number }
        >(`
          SELECT project                AS key,
                 sum(costTotal)         AS cost,
                 count(*)               AS turns,
                 sum(costCacheRead)     AS cacheRead,
                 sum(costCacheCreate)   AS cacheCreate,
                 sum(costOutput)        AS output,
                 sum(costInput)         AS input
          FROM turns
          GROUP BY 1
          ORDER BY cost DESC
        `),
      { scope: appScope },
    ),

    /**
     * Cost by what *caused* it — skill, MCP server, agent type. The efficiency
     * axis: these columns are sparse, so the null bucket is a real category and
     * is labelled rather than dropped.
     */
    attribution: cell(
      () => ({}),
      async () =>
        store.sql<CostSlice & { kind: string }>(`
          SELECT 'agent'      AS kind, coalesce(agentType, '(main loop)') AS key,
                 sum(costTotal) AS cost, count(*) AS turns
          FROM turns GROUP BY 1, 2
          UNION ALL
          SELECT 'skill', coalesce(attributionSkill, '(none)'),
                 sum(costTotal), count(*)
          FROM turns GROUP BY 1, 2
          UNION ALL
          SELECT 'mcp', coalesce(attributionMcpServer, '(none)'),
                 sum(costTotal), count(*)
          FROM turns GROUP BY 1, 2
          ORDER BY kind, cost DESC
        `),
      { scope: appScope },
    ),

    /**
     * Sessions recomputed against the reader's idle threshold.
     *
     * The parquet already carries an activeSeconds computed at normalize time,
     * but it was computed with ONE threshold. Recomputing here from raw turn
     * timestamps is what makes `idleGapMinutes` a live control instead of a
     * decoration — the whole point of exposing it.
     */
    sessions: cell(
      () => ({ gapMin: idleGapMinutes.get() }),
      async ({ gapMin }) => {
        const gapMs = Math.max(1, gapMin) * 60_000;
        return store
          .sql<SessionShape>(`
          WITH gaps AS (
            SELECT sessionId,
                   epoch_ms(ts) AS t,
                   epoch_ms(ts) - lag(epoch_ms(ts)) OVER (PARTITION BY sessionId ORDER BY ts) AS dt,
                   costTotal,
                   cacheReadTokens
            FROM turns
          )
          SELECT g.sessionId,
                 any_value(s.project)                              AS project,
                 any_value(s.slug)                                 AS slug,
                 min(g.t)                                          AS firstTs,
                 max(g.t)                                          AS lastTs,
                 (max(g.t) - min(g.t)) / 1000.0                    AS spanSeconds,
                 coalesce(sum(CASE WHEN g.dt > 0 AND g.dt < ${gapMs} THEN g.dt END), 0) / 1000.0
                                                                   AS activeSeconds,
                 count(*)                                          AS nTurns,
                 any_value(s.nCompactions)                         AS nCompactions,
                 max(g.cacheReadTokens)                            AS peakContextTokens,
                 sum(g.costTotal)                                  AS cost
          FROM gaps g
          LEFT JOIN sessions s USING (sessionId)
          GROUP BY g.sessionId
          HAVING count(*) > 1
          ORDER BY cost DESC
        `)
          .then((rows) =>
            rows.map((r) => ({
              ...r,
              dutyCycle: r.spanSeconds > 0 ? r.activeSeconds / r.spanSeconds : 1,
            })),
          );
      },
      { scope: appScope },
    ),

    /**
     * Images: estimated tokens, deduplicated by content hash. `tool_result` and
     * `toolUseResult` are two views of one payload, so a naive count of rows
     * would nearly double the real image count.
     */
    images: cell(
      () => ({}),
      async () =>
        store.sql<{ mediaType: string; n: number; estTokens: number; megapixels: number }>(`
          WITH distinct_images AS (
            SELECT hash, any_value(mediaType) AS mediaType,
                   any_value(estTokens) AS estTokens,
                   any_value(width) AS width, any_value(height) AS height
            FROM images GROUP BY hash
          )
          SELECT mediaType,
                 count(*)                          AS n,
                 sum(estTokens)                    AS estTokens,
                 sum(width * height) / 1e6         AS megapixels
          FROM distinct_images
          GROUP BY 1 ORDER BY estTokens DESC
        `),
      { scope: appScope },
    ),
  }),
  // Passed, not read here: `import.meta.hot` is bound to THIS module, and a
  // library can't self-accept on our behalf. See hotCellGraph's docs.
  import.meta.hot,
);

/** The graph's shape, inferred — components can type against it. */
export type AppGraph = ReturnType<typeof graph>;

// --- the agent surface: derived from the declarations -------------------------
//
// Controls (store.ts) and actions (declared next to their features) surface
// automatically: `registerStandardTools` provides `report` (the whole picture:
// controls, cells, actions, dependency edges), `set` (validated through each
// control's own meta), `locate`, and one real tool per action. Hand-write a
// kit.registerTool(...) only for operations that are genuinely neither a value
// nor a verb-with-args. Registration is idempotent by name (HMR-safe).

// The toolkit namespace is the app's slug: tools install at window.__<slug>.
const kit = agentToolkit(appScope.name);

// `locate` (element → source) and the `cells` attribution table: app-independent,
// and every aiui app should have them.
registerStandardTools(kit);

/**
 * Ad-hoc SQL over the five grains. This is the one genuinely bespoke tool here:
 * "what did I spend on X" is an open-ended question and no fixed set of
 * controls covers it, so the agent gets the query surface directly. Read-only
 * by construction — DuckDB-WASM holds a throwaway in-memory database built from
 * the parquet, so the worst a bad query can do is fail.
 */
export const querySql = action({
  scope: appScope,
  name: "query",
  description:
    "Run read-only SQL over the loaded tables: turns, toolCalls, events, sessions, images. " +
    "Returns at most 200 rows as JSON. See aiui-transcript's normalize.ts for the column list.",
  params: { sql: "A DuckDB SELECT statement over turns/toolCalls/events/sessions/images." },
  run: async (args?: Record<string, unknown>) => {
    const query = typeof args?.sql === "string" ? args.sql : "";
    if (!query.trim()) return { error: "no sql provided" };
    const rows = await store.sql(`SELECT * FROM (${query}) LIMIT 200`);
    return { rows: rows.length, data: rows };
  },
});
