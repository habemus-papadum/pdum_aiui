/**
 * aiui Claude Code channel — an MCP server (stdio) that pushes aiui events into
 * a Claude Code session by declaring the experimental `claude/channel`
 * capability.
 *
 * @packageDocumentation
 */

export {
  agentsByPid,
  type ClaudeAgent,
  type EnrichedServer,
  enrichServers,
  listClaudeAgents,
  parseClaudeAgents,
  type SessionInfo,
} from "./agents";
export {
  type ChannelConnection,
  type ChannelConnectionOptions,
  type ChannelResponse,
  createChannelConnection,
  type ProcessorRegistry,
  type SendPrompt,
  type StreamProcessor,
  type StreamProcessorFactory,
  type ThreadContext,
} from "./channel";
export { channelCliPath } from "./cli-path";
export { CHANNEL_CONFIG } from "./commands/config";
export { dirRank, type ListOptions, listMcpServers, sortServers } from "./list";
export { defaultProcessors, textConcatProcessor } from "./processors";
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
export { selectMcpServer, serverLabel } from "./select";
export { type SendResult, sendPrompt, sendPromptByTag } from "./send";
export {
  type SendPromptWsOptions,
  sendPromptWs,
  sendPromptWsByTag,
  type WsSendResult,
} from "./send-ws";
export { createChannelServer } from "./server";
export { type ChannelInfo, collectChannelInfo, registerChannelTools } from "./tools";
export { type PromptHandler, startWebServer, type WebServer, type WebServerOptions } from "./web";

/** The published package name — handy for smoke tests. */
export const name = "@habemus-papadum/aiui-claude-channel";
