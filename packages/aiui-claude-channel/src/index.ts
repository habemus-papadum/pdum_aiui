/**
 * aiui Claude Code channel — an MCP server (stdio) that pushes aiui events into
 * a Claude Code session by declaring the experimental `claude/channel`
 * capability.
 *
 * @packageDocumentation
 */

export { channelCliPath } from "./cli-path";
export { CHANNEL_CONFIG } from "./commands/config";
export { dirRank, type ListOptions, listMcpServers, sortServers } from "./list";
export {
  isProcessAlive,
  type RegisteredServer,
  type RegistryEntry,
  type RunningServer,
  readEntry,
  registerServer,
  registryDir,
  registryFileFor,
  removeEntryFile,
} from "./registry";
export { selectMcpServer } from "./select";
export { type SendResult, sendPrompt, sendPromptByTag } from "./send";
export { createChannelServer } from "./server";
export { type PromptHandler, startWebServer, type WebServer, type WebServerOptions } from "./web";

/** The published package name — handy for smoke tests. */
export const name = "@habemus-papadum/aiui-claude-channel";
