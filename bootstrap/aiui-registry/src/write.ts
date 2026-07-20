/**
 * The WRITE side of the registry. Entries are **write-once** (written at
 * registration, then only ever deleted) and **atomic** (temp sibling +
 * `rename`), so readers see either nothing or a complete entry, never a tear.
 *
 * Deliberately NO locks: the filename is the writer's pid (single writer per
 * file), entries never update in place, and deletes tolerate racing. There is
 * nothing to lock — do not add locking here (docs/proposals/aiui-registry.md §1).
 */
import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registryDir } from "./paths.ts";
import { type ChannelKind, ENTRY_SCHEMA, type RegistryEntry } from "./types.ts";

/**
 * Write `content` to `file` atomically: write a pid-unique temp sibling, then
 * `rename` over the destination. The pid suffix keeps concurrent writers of a
 * SHARED file (the agents cache) from truncating each other's temp file;
 * rename makes last-writer-wins safe.
 */
export function writeFileAtomic(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

/** Absolute path to the registry file a process with `pid` would own. */
export function registryFileFor(pid: number, dir: string = registryDir()): string {
  return join(dir, `${pid}.json`);
}

/**
 * Delete a registry file, tolerating the race where it's already gone.
 * Multiple readers may prune the same stale file concurrently, and a server
 * may delete its own file at the same moment — `ENOENT` is a success, not an
 * error. Any other failure is surfaced.
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

/** What {@link registerServer} needs; process facts default to this process. */
export interface RegisterOptions {
  port: number;
  tag: string;
  kind: ChannelKind;
  assignedName?: string;
  browserUrl?: string;
  host?: string;
  /** Overrides (tests, unusual registrars). */
  pid?: number;
  ppid?: number;
  cwd?: string;
  startedAt?: string;
  registryDir?: string;
}

/** A handle to a written registry file. */
export interface RegisteredServer {
  /** The metadata that was written. */
  entry: RegistryEntry;
  /** Absolute path to the registry file. */
  file: string;
  /** Remove the registry file (idempotent / race-safe). */
  remove: () => void;
}

/**
 * Advertise a running server by writing its registry entry (atomically), and
 * hand back a {@link RegisteredServer} whose `remove()` deletes it again. The
 * caller owns wiring `remove()` into its shutdown path; a hard kill is caught
 * by readers' liveness pruning instead.
 */
export function registerServer(options: RegisterOptions): RegisteredServer {
  const entry: RegistryEntry = {
    schema: ENTRY_SCHEMA,
    tag: options.tag,
    pid: options.pid ?? process.pid,
    ppid: options.ppid ?? process.ppid,
    port: options.port,
    cwd: options.cwd ?? process.cwd(),
    startedAt: options.startedAt ?? new Date().toISOString(),
    kind: options.kind,
    ...(options.assignedName !== undefined ? { assignedName: options.assignedName } : {}),
    ...(options.browserUrl !== undefined ? { browserUrl: options.browserUrl } : {}),
    ...(options.host !== undefined ? { host: options.host } : {}),
  };
  const file = registryFileFor(entry.pid, options.registryDir);
  writeFileAtomic(file, `${JSON.stringify(entry, null, 2)}\n`);
  return { entry, file, remove: () => removeEntryFile(file) };
}
