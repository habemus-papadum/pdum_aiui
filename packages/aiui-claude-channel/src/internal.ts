/**
 * WORKSPACE-INTERNAL seam — channel-discovery/CLI plumbing consumed by the
 * `aiui` launcher and sibling dev scripts. Not a public contract: no semver
 * promise; symbols here may change or vanish in any release.
 *
 * @packageDocumentation
 */

export { agentsByPid, type ClaudeAgent, listClaudeAgents } from "./agents";
export { type ListOptions, listMcpServers } from "./list";
export type { RegistryEntry, RunningServer } from "./registry";
export { selectMcpServer } from "./select";
export { projectCacheDir } from "./trace";
