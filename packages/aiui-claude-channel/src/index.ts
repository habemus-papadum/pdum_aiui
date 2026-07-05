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
  type ChannelFormat,
  type ChannelResponse,
  createChannelConnection,
  type FormatRegistry,
  type MessageMeta,
  type SendPrompt,
  type StreamProcessor,
  type StreamProcessorFactory,
  type ThreadContext,
} from "./channel";
export { channelCliPath } from "./cli-path";
export {
  type ChannelClient,
  type ChannelClientOptions,
  type ChannelThread,
  connectChannelClient,
} from "./client";
export { jsonCodec, type PayloadCodec, rawCodec } from "./codec";
export { CHANNEL_CONFIG } from "./commands/config";
export {
  type DecodedFrame,
  decodeFrame,
  type Envelope,
  type EnvelopeKind,
  encodeFrame,
  type HelloMeta,
  PROTOCOL_VERSION,
  type SourceInfo,
  type TabInfo,
} from "./frame";
export {
  type ChromeDevtoolsInfo,
  type LaunchInfo,
  type OpenAiKeyStatus,
  parseLaunchInfo,
} from "./launch-info";
export { dirRank, type ListOptions, listMcpServers, sortServers } from "./list";
export {
  type PageToolCall,
  type PageToolDescriptor,
  PageToolDirectory,
  type PageToolDirectoryOptions,
  type PageToolRegistration,
  type PageToolSend,
  type PageToolSummary,
  type ServerToClientMessage,
} from "./page-tools";
export {
  augmentTextPrompt,
  defaultFormats,
  type SelectionContext,
  textConcatFormat,
  textConcatProcessor,
} from "./processors";
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
export { type ChannelServerOptions, createChannelServer } from "./server";
export {
  createTransportStats,
  type FrameStat,
  type TransportSnapshot,
  type TransportStats,
} from "./stats";
export {
  type ChannelInfo,
  collectChannelInfo,
  registerChannelTools,
  selfChannelInfo,
  type UnregisteredInfo,
} from "./tools";
export {
  createTraceStore,
  listTraces,
  PROJECT_CACHE_DIRNAME,
  projectCacheDir,
  readTrace,
  type TraceHandle,
  type TraceManifest,
  type TraceStage,
  type TraceStageKind,
  type TraceStore,
  traceBlobPath,
} from "./trace";
export { type TracingThreadContext, traceOf, withTracing } from "./tracing";
export { type PromptHandler, startWebServer, type WebServer, type WebServerOptions } from "./web";

/** The published package name — handy for smoke tests. */
export const name = "@habemus-papadum/aiui-claude-channel";
