/**
 * Writing the five grains to Parquet.
 *
 * `hyparquet-writer` is pure JS — no native module, so CI installs cannot break
 * on it, and the same files are read back by DuckDB-WASM in the browser demo.
 *
 * Two things it demands that shape the code below:
 *
 *  - **INT64 columns want BigInt**, not number. Timestamps and token counts are
 *    therefore converted at the boundary. Costs stay DOUBLE (they are fractions
 *    of a cent and exactness is meaningless).
 *  - **Columns are typed up front**, so a column that is all-null still needs a
 *    declared type. `col()` handles that rather than letting the writer infer
 *    from an empty array.
 */

import { parquetWriteFile } from "hyparquet-writer";
import type {
  EventRow,
  ImageRow,
  Normalized,
  SessionRow,
  ToolCallRow,
  TurnRow,
} from "./normalize.ts";

type ColType = "STRING" | "DOUBLE" | "INT64" | "BOOLEAN" | "TIMESTAMP";
interface ColumnData {
  name: string;
  data: unknown[];
  type: ColType;
}

/** Pull one column out of a row array, coercing to what the writer accepts. */
function col<T>(name: string, rows: T[], type: ColType, pick: (r: T) => unknown): ColumnData {
  const data = rows.map((r) => {
    const v = pick(r);
    if (v === undefined || v === null) return null;
    if (type === "INT64" || type === "TIMESTAMP") {
      const n = typeof v === "bigint" ? v : BigInt(Math.round(Number(v)));
      return n;
    }
    if (type === "DOUBLE") return Number(v);
    if (type === "BOOLEAN") return Boolean(v);
    return String(v);
  });
  return { name, data, type };
}

const turnColumns = (rows: TurnRow[]): ColumnData[] => [
  col("messageId", rows, "STRING", (r) => r.messageId),
  col("requestId", rows, "STRING", (r) => r.requestId),
  col("sessionId", rows, "STRING", (r) => r.sessionId),
  col("fileSessionId", rows, "STRING", (r) => r.fileSessionId),
  col("projectSlug", rows, "STRING", (r) => r.projectSlug),
  col("project", rows, "STRING", (r) => r.project),
  col("cwd", rows, "STRING", (r) => r.cwd),
  col("gitBranch", rows, "STRING", (r) => r.gitBranch),
  col("ts", rows, "TIMESTAMP", (r) => r.ts),
  col("model", rows, "STRING", (r) => r.model),
  col("modelVariant", rows, "STRING", (r) => r.modelVariant),
  col("effort", rows, "STRING", (r) => r.effort),
  col("stopReason", rows, "STRING", (r) => r.stopReason),
  col("serviceTier", rows, "STRING", (r) => r.serviceTier),
  col("speed", rows, "STRING", (r) => r.speed),
  col("context", rows, "STRING", (r) => r.context),
  col("agentId", rows, "STRING", (r) => r.agentId),
  col("agentType", rows, "STRING", (r) => r.agentType),
  col("entrypoint", rows, "STRING", (r) => r.entrypoint),
  col("sessionKind", rows, "STRING", (r) => r.sessionKind),
  col("ccVersion", rows, "STRING", (r) => r.ccVersion),
  col("attributionSkill", rows, "STRING", (r) => r.attributionSkill),
  col("attributionPlugin", rows, "STRING", (r) => r.attributionPlugin),
  col("attributionMcpServer", rows, "STRING", (r) => r.attributionMcpServer),
  col("attributionMcpTool", rows, "STRING", (r) => r.attributionMcpTool),
  col("inputTokens", rows, "INT64", (r) => r.inputTokens),
  col("outputTokens", rows, "INT64", (r) => r.outputTokens),
  col("cacheCreate5m", rows, "INT64", (r) => r.cacheCreate5m),
  col("cacheCreate1h", rows, "INT64", (r) => r.cacheCreate1h),
  col("cacheReadTokens", rows, "INT64", (r) => r.cacheReadTokens),
  col("webSearches", rows, "INT64", (r) => r.webSearches),
  col("webFetches", rows, "INT64", (r) => r.webFetches),
  col("hadFallback", rows, "BOOLEAN", (r) => r.hadFallback),
  col("wastedOutputTokens", rows, "INT64", (r) => r.wastedOutputTokens),
  col("nBlocks", rows, "INT64", (r) => r.nBlocks),
  col("nThinkingChars", rows, "INT64", (r) => r.nThinkingChars),
  col("nToolUses", rows, "INT64", (r) => r.nToolUses),
  col("nImages", rows, "INT64", (r) => r.nImages),
  col("estImageTokens", rows, "INT64", (r) => r.estImageTokens),
  col("aborted", rows, "BOOLEAN", (r) => r.aborted),
  col("costInput", rows, "DOUBLE", (r) => r.costInput),
  col("costOutput", rows, "DOUBLE", (r) => r.costOutput),
  col("costCacheCreate", rows, "DOUBLE", (r) => r.costCacheCreate),
  col("costCacheRead", rows, "DOUBLE", (r) => r.costCacheRead),
  col("costTotal", rows, "DOUBLE", (r) => r.costTotal),
  col("pricingVersion", rows, "STRING", (r) => r.pricingVersion),
  col("unpriced", rows, "BOOLEAN", (r) => r.unpriced),
];

const toolCallColumns = (rows: ToolCallRow[]): ColumnData[] => [
  col("messageId", rows, "STRING", (r) => r.messageId),
  col("toolUseId", rows, "STRING", (r) => r.toolUseId),
  col("sessionId", rows, "STRING", (r) => r.sessionId),
  col("ts", rows, "TIMESTAMP", (r) => r.ts),
  col("toolName", rows, "STRING", (r) => r.toolName),
  col("isMcp", rows, "BOOLEAN", (r) => r.isMcp),
  col("mcpServer", rows, "STRING", (r) => r.mcpServer),
  col("context", rows, "STRING", (r) => r.context),
  col("ok", rows, "BOOLEAN", (r) => r.ok),
  col("interrupted", rows, "BOOLEAN", (r) => r.interrupted),
  col("errorKind", rows, "STRING", (r) => r.errorKind),
  col("exitCode", rows, "INT64", (r) => r.exitCode),
  col("durationMs", rows, "INT64", (r) => r.durationMs),
];

const eventColumns = (rows: EventRow[]): ColumnData[] => [
  col("ts", rows, "TIMESTAMP", (r) => r.ts),
  col("sessionId", rows, "STRING", (r) => r.sessionId),
  col("projectSlug", rows, "STRING", (r) => r.projectSlug),
  col("kind", rows, "STRING", (r) => r.kind),
  col("payload", rows, "STRING", (r) => r.payload),
];

const sessionColumns = (rows: SessionRow[]): ColumnData[] => [
  col("sessionId", rows, "STRING", (r) => r.sessionId),
  col("projectSlug", rows, "STRING", (r) => r.projectSlug),
  col("project", rows, "STRING", (r) => r.project),
  col("cwd", rows, "STRING", (r) => r.cwd),
  col("slug", rows, "STRING", (r) => r.slug),
  col("firstTs", rows, "TIMESTAMP", (r) => r.firstTs),
  col("lastTs", rows, "TIMESTAMP", (r) => r.lastTs),
  col("spanSeconds", rows, "DOUBLE", (r) => r.spanSeconds),
  col("activeSeconds", rows, "DOUBLE", (r) => r.activeSeconds),
  col("dutyCycle", rows, "DOUBLE", (r) => r.dutyCycle),
  col("nTurnsNative", rows, "INT64", (r) => r.nTurnsNative),
  col("nSubagentTurns", rows, "INT64", (r) => r.nSubagentTurns),
  col("nCompactions", rows, "INT64", (r) => r.nCompactions),
  col("peakContextTokens", rows, "INT64", (r) => r.peakContextTokens),
  col("nativeCost", rows, "DOUBLE", (r) => r.nativeCost),
  col("models", rows, "STRING", (r) => r.models),
  col("ccVersions", rows, "STRING", (r) => r.ccVersions),
];

const imageColumns = (rows: ImageRow[]): ColumnData[] => [
  col("uuid", rows, "STRING", (r) => r.uuid),
  col("sessionId", rows, "STRING", (r) => r.sessionId),
  col("ts", rows, "TIMESTAMP", (r) => r.ts),
  col("carrier", rows, "STRING", (r) => r.carrier),
  col("mediaType", rows, "STRING", (r) => r.mediaType),
  col("width", rows, "INT64", (r) => r.width),
  col("height", rows, "INT64", (r) => r.height),
  col("bytesBase64", rows, "INT64", (r) => r.bytesBase64),
  col("estTokens", rows, "INT64", (r) => r.estTokens),
  col("hash", rows, "STRING", (r) => r.hash),
];

export const TABLES = ["turns", "toolCalls", "events", "sessions", "images"] as const;
export type TableName = (typeof TABLES)[number];

export function columnsFor(name: TableName, n: Normalized): ColumnData[] {
  switch (name) {
    case "turns":
      return turnColumns(n.turns);
    case "toolCalls":
      return toolCallColumns(n.toolCalls);
    case "events":
      return eventColumns(n.events);
    case "sessions":
      return sessionColumns(n.sessions);
    case "images":
      return imageColumns(n.images);
  }
}

export function rowCount(name: TableName, n: Normalized): number {
  switch (name) {
    case "turns":
      return n.turns.length;
    case "toolCalls":
      return n.toolCalls.length;
    case "events":
      return n.events.length;
    case "sessions":
      return n.sessions.length;
    case "images":
      return n.images.length;
  }
}

/**
 * Write all five tables into `dir`. Returns per-table byte sizes.
 *
 * A table with no rows is still written: an absent file makes the demo's
 * queries fail at load, while an empty one just yields no rows.
 */
export async function writeParquet(
  dir: string,
  n: Normalized,
  fs: {
    mkdir: (p: string, o: { recursive: true }) => Promise<unknown>;
    stat: (p: string) => Promise<{ size: number }>;
  },
  join: (...p: string[]) => string,
): Promise<Record<string, { rows: number; bytes: number }>> {
  await fs.mkdir(dir, { recursive: true });
  const out: Record<string, { rows: number; bytes: number }> = {};
  for (const name of TABLES) {
    const filename = join(dir, `${name}.parquet`);
    parquetWriteFile({ filename, columnData: columnsFor(name, n) as never });
    out[name] = { rows: rowCount(name, n), bytes: (await fs.stat(filename)).size };
  }
  return out;
}
