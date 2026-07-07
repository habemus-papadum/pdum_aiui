/**
 * The on-disk registry of running aiui channel MCP servers.
 *
 * Each live channel server process advertises itself by writing a small JSON
 * file into the shared cache (`cacheDir("mcp")`), named `<pid>.json` — the
 * real `mcp` servers, and the standalone `serve` debug servers, which register
 * with `debug: true` so selectors can mark them (and never auto-pick one).
 * The file records enough to find and talk to the server's web backend, and to
 * tell whether the process behind it is still alive. A server removes its own
 * file on exit; {@link listMcpServers} prunes any left behind by a hard kill.
 */
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cacheDir } from "@habemus-papadum/aiui-util";

/** The cache namespace under which registry files live (`~/.cache/aiui/mcp`). */
const REGISTRY_NAMESPACE = "mcp";

/** A single running server's advertised metadata, as stored on disk. */
export interface RegistryEntry {
  /**
   * Stable identifier for this channel session — a UUID by default, or a value
   * chosen by the launcher (e.g. a test harness that wants to know the tag in
   * advance so it can address this exact server). Tools use it to target a
   * specific server without going through the interactive selector.
   */
  tag: string;
  /** PID of the MCP server process itself. */
  pid: number;
  /**
   * PID of the parent process — the Claude Code session that spawned this
   * server over stdio. Not redundant with {@link RegistryEntry.pid}: this
   * points at Claude Code, that points at the channel server.
   */
  ppid: number;
  /** TCP port the server's web backend (POST/GET/websocket) is listening on. */
  port: number;
  /** Absolute working directory the server was launched in. */
  cwd: string;
  /** ISO-8601 timestamp of when the server started. */
  startedAt: string;
  /**
   * Human-chosen display name (e.g. the workbench names its channel
   * "aiui workbench"). Selectors prefer it over pids; absent on servers that
   * are recognisable by their owning Claude Code session instead.
   */
  name?: string;
  /**
   * A standalone debug server (`serve`): structurally unable to reach a Claude
   * Code session — lowered prompts print to its stdout. Selectors must mark
   * these, and nothing may *auto*-pick one; a human choosing it deliberately
   * is fine (see select.ts).
   */
  debug?: boolean;
}

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

/**
 * Resolve the directory holding server registry files. Creates it by default;
 * pass `{ create: false }` on read paths that shouldn't materialize it as a
 * side effect (so a missing directory can mean "nothing is running").
 */
export function registryDir(options: { create?: boolean } = {}): string {
  return cacheDir(REGISTRY_NAMESPACE, { create: options.create ?? true });
}

/** Absolute path to the registry file a process with `pid` would own. */
export function registryFileFor(pid: number): string {
  return join(registryDir(), `${pid}.json`);
}

/**
 * Is a process with this PID currently alive?
 *
 * `process.kill(pid, 0)` sends no signal but performs the permission/existence
 * check: it throws `ESRCH` when no such process exists, and `EPERM` when the
 * process exists but we're not allowed to signal it — the latter still means
 * "alive".
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
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
 * Read and validate a single registry file. Returns `null` for anything that
 * isn't a well-formed entry (missing, unreadable, malformed, or mid-write) so
 * callers can skip it without deleting a possibly-live server's file.
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
    typeof e.tag !== "string" ||
    typeof e.pid !== "number" ||
    typeof e.ppid !== "number" ||
    typeof e.port !== "number" ||
    typeof e.cwd !== "string" ||
    typeof e.startedAt !== "string"
  ) {
    return null;
  }
  return {
    tag: e.tag,
    pid: e.pid,
    ppid: e.ppid,
    port: e.port,
    cwd: e.cwd,
    startedAt: e.startedAt,
    // Optional fields tolerate older writers: absent is simply "a real server".
    ...(typeof e.name === "string" ? { name: e.name } : {}),
    ...(e.debug === true ? { debug: true } : {}),
  };
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
