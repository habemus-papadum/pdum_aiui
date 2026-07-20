/**
 * The READ side of the on-disk registry of running aiui channel servers —
 * shared by everything that discovers channels: the channel package itself
 * (which also owns the write side) and the VS Code extension.
 *
 * Each live channel server advertises itself by writing a `<pid>.json` file
 * into `cacheDir("mcp")`; this module knows the entry shape, how to loosely
 * validate one such file, and how to tell whether the process behind it is
 * still alive. It lives here — next to {@link cacheDir}, a prod dependency of
 * both discoverers — so neither the extension's VSIX bundle nor the channel
 * has to mirror the other's copy.
 */
// TODO(aiui-registry): this whole read side moves to @habemus-papadum/aiui-registry
// (docs/proposals/aiui-registry.md §7); delete this module in M4.
import { readFileSync } from "node:fs";
import { cacheDir } from "./index";

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
   * Human-chosen display name (a debug server's `--name`). Selectors prefer
   * it over pids; absent on servers that
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

/**
 * Resolve the directory holding server registry files. Creates it by default;
 * pass `{ create: false }` on read paths that shouldn't materialize it as a
 * side effect (so a missing directory can mean "nothing is running").
 */
export function registryDir(options: { create?: boolean } = {}): string {
  return cacheDir(REGISTRY_NAMESPACE, { create: options.create ?? true });
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
