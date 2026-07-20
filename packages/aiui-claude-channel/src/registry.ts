/**
 * The on-disk registry of running aiui channel servers — this package's façade
 * over `@habemus-papadum/aiui-registry`, the npm-pinned bootstrap package that
 * single-sources the whole thing (docs/proposals/aiui-registry.md): schema-v2
 * entries, atomic writes, liveness with recycled-pid detection, and the
 * ENRICHED listing (live session names via the shared 4 s `claude agents`
 * cache, `resolvedName`, loud claude-missing status).
 *
 * Real `mcp` servers register `kind: "channel"`; standalone `serve` debug
 * servers register `kind: "debug"` (+ an `assignedName`) so selectors can mark
 * them and never auto-pick one. A server removes its own file on exit;
 * {@link listMcpServers} prunes what a hard kill leaves behind.
 */
import {
  type AgentsStatus,
  type ChannelKind,
  type ChannelListing,
  type EnrichedChannel,
  isProcessAlive,
  listChannels,
  type RegisteredServer,
  type RegistryEntry,
  readEntry,
  registerServer,
  registryDir,
  registryFileFor,
  removeEntryFile,
  type SessionInfo,
} from "@habemus-papadum/aiui-registry";

export {
  type AgentsStatus,
  type ChannelKind,
  type ChannelListing,
  type EnrichedChannel,
  isProcessAlive,
  listChannels,
  type RegisteredServer,
  type RegistryEntry,
  readEntry,
  registerServer,
  registryDir,
  registryFileFor,
  removeEntryFile,
  type SessionInfo,
};

/**
 * Historical name for the enriched channel — kept as an alias so the many
 * consumers of `listMcpServers` (send, quick, the aiui CLI, dev scripts)
 * didn't all have to rename in one migration.
 */
export type RunningServer = EnrichedChannel;

export interface ListOptions {
  /**
   * Delete registry files whose process is dead or recycled. Defaults to
   * `true`. Pruning is best-effort and race-safe.
   */
  prune?: boolean;
}

/**
 * List the channel servers currently running — fully ENRICHED (session join,
 * `resolvedName`), ranked by directory affinity to `dir` (defaults to the
 * current working directory). The listing's agents status is dropped here;
 * surfaces that must show it loudly (the debug API, the native host) call
 * {@link listChannels} directly.
 */
export function listMcpServers(
  dir: string = process.cwd(),
  options: ListOptions = {},
): RunningServer[] {
  return listChannels({
    client: "cli",
    baseDir: dir,
    prune: options.prune ?? true,
  }).channels;
}
