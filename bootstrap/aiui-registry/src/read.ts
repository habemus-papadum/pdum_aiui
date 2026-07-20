/**
 * The raw READ side of the registry: validate one entry file, scan a
 * directory. Liveness and enrichment live one layer up (`liveness.ts`,
 * `list.ts`) — this module never prunes.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type ChannelKind, ENTRY_SCHEMA, type RegistryEntry, type StoredEntry } from "./types.ts";

const KINDS: readonly string[] = ["channel", "debug", "remote"] satisfies ChannelKind[];

/**
 * Read and validate a single registry file. Returns `null` for anything that
 * isn't a well-formed schema-v2 entry — missing, unreadable, malformed,
 * mid-write, or an old-schema entry (no migration shims; readers recognise
 * only `schema: 2`). Callers skip nulls without deleting the file: it may
 * belong to a live server still writing itself in.
 */
export function readEntry(file: string): RegistryEntry | null {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const e = parsed as Record<string, unknown>;
  if (
    e.schema !== ENTRY_SCHEMA ||
    typeof e.tag !== "string" ||
    typeof e.pid !== "number" ||
    typeof e.ppid !== "number" ||
    typeof e.port !== "number" ||
    typeof e.cwd !== "string" ||
    typeof e.startedAt !== "string" ||
    typeof e.kind !== "string" ||
    !KINDS.includes(e.kind)
  ) {
    return null;
  }
  return {
    schema: ENTRY_SCHEMA,
    tag: e.tag,
    pid: e.pid,
    ppid: e.ppid,
    port: e.port,
    cwd: e.cwd,
    startedAt: e.startedAt,
    kind: e.kind as ChannelKind,
    ...(typeof e.assignedName === "string" ? { assignedName: e.assignedName } : {}),
    ...(typeof e.browserUrl === "string" ? { browserUrl: e.browserUrl } : {}),
    ...(typeof e.host === "string" ? { host: e.host } : {}),
  };
}

/**
 * Scan a registry directory into validated entries (each paired with its
 * file). A missing directory means "nothing is running" → `[]`. Malformed and
 * old-schema files are skipped, never deleted.
 */
export function scanEntries(dir: string): StoredEntry[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
  const entries: StoredEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) {
      continue;
    }
    const file = join(dir, name);
    const entry = readEntry(file);
    if (entry) {
      entries.push({ ...entry, file });
    }
  }
  return entries;
}
