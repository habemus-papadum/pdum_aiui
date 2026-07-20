/**
 * The on-disk registry of running aiui channel MCP servers — this package's
 * façade over it.
 *
 * The WRITE side ({@link registerServer}: schema-v2 entries, atomic
 * temp+rename) is single-sourced in `@habemus-papadum/aiui-registry` — the
 * npm-pinned bootstrap package whose formats are the cross-process protocol
 * (docs/proposals/aiui-registry.md) — and re-exported here so callers keep
 * importing from `./registry`. Real `mcp` servers register `kind: "channel"`;
 * standalone `serve` debug servers register `kind: "debug"` (+ an
 * `assignedName`) so selectors can mark them and never auto-pick one. A server
 * removes its own file on exit; {@link listMcpServers} prunes what's left
 * behind by a hard kill.
 *
 * The v1 READ side — {@link readEntry}, {@link isProcessAlive},
 * {@link registryDir} from `@habemus-papadum/aiui-util` — remains until M4
 * moves every reader onto the registry package's enriched listing. (A v1
 * reader accepts v2 entries: the required fields are a subset; only the
 * display extras differ.)
 */
// TODO(aiui-registry): the read side below moves to the registry package's
// enriched listChannels in M4 (docs/proposals/aiui-registry.md §4).
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  isProcessAlive,
  type RegistryEntry,
  readEntry,
  registryDir,
} from "@habemus-papadum/aiui-util";

export { type RegisteredServer, registerServer } from "@habemus-papadum/aiui-registry";
export { isProcessAlive, type RegistryEntry, readEntry, registryDir };

/** A registry entry paired with the file it was read from. */
export interface RunningServer extends RegistryEntry {
  /** Absolute path to the `<pid>.json` registry file this entry came from. */
  file: string;
}

/** Absolute path to the registry file a process with `pid` would own. */
export function registryFileFor(pid: number): string {
  return join(registryDir(), `${pid}.json`);
}

/**
 * Delete a registry file, tolerating the race where it's already gone.
 *
 * Multiple tools may prune the same stale file concurrently, and a server may
 * delete its own file at the same moment — so a missing file (`ENOENT`) is a
 * success, not an error. Any other failure is surfaced.
 */
export function removeEntryFile(file: string): void {
  try {
    unlinkSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}
