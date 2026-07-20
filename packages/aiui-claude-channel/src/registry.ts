/**
 * The on-disk registry of running aiui channel MCP servers — the WRITE side.
 *
 * Each live channel server process advertises itself by writing a small JSON
 * file into the shared cache (`cacheDir("mcp")`), named `<pid>.json` — the
 * real `mcp` servers, and the standalone `serve` debug servers, which register
 * with `debug: true` so selectors can mark them (and never auto-pick one).
 * The file records enough to find and talk to the server's web backend, and to
 * tell whether the process behind it is still alive. A server removes its own
 * file on exit; {@link listMcpServers} prunes any left behind by a hard kill.
 *
 * The READ side — the {@link RegistryEntry} shape, {@link readEntry} validator,
 * {@link isProcessAlive} liveness probe, and {@link registryDir} — lives in
 * `@habemus-papadum/aiui-util` (a prod dep of both this package and the VS Code
 * extension) so both discoverers share one copy; it is re-exported here so this
 * package's callers keep importing it from `./registry`.
 */
// TODO(aiui-registry): the write side moves to @habemus-papadum/aiui-registry in M3
// (schema-v2 entries, atomic rename; docs/proposals/aiui-registry.md §1, §3).
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  isProcessAlive,
  type RegistryEntry,
  readEntry,
  registryDir,
} from "@habemus-papadum/aiui-util";

export { isProcessAlive, type RegistryEntry, readEntry, registryDir };

/** A registry entry paired with the file it was read from. */
export interface RunningServer extends RegistryEntry {
  /** Absolute path to the `<pid>.json` registry file this entry came from. */
  file: string;
}

/** A handle to this process's own registry file. */
export interface RegisteredServer {
  /** The metadata that was written. */
  entry: RegistryEntry;
  /** Absolute path to the registry file. */
  file: string;
  /** Remove the registry file (idempotent / race-safe). */
  remove: () => void;
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

/**
 * Advertise the current process as a running channel server by writing its
 * registry file, and hand back a {@link RegisteredServer} whose `remove()`
 * deletes it again. The caller owns wiring `remove()` into its shutdown path.
 * Debug servers pass `{ debug: true }` (and usually a display `name`) so every
 * selector can mark them.
 */
export function registerServer(
  port: number,
  tag: string,
  options: { name?: string; debug?: boolean } = {},
): RegisteredServer {
  const entry: RegistryEntry = {
    tag,
    pid: process.pid,
    ppid: process.ppid,
    port,
    cwd: process.cwd(),
    startedAt: new Date().toISOString(),
    ...(options.name !== undefined ? { name: options.name } : {}),
    ...(options.debug === true ? { debug: true } : {}),
  };
  const file = registryFileFor(entry.pid);
  writeFileSync(file, `${JSON.stringify(entry, null, 2)}\n`);
  return { entry, file, remove: () => removeEntryFile(file) };
}
