/**
 * aiui Claude Code channel — an MCP server (stdio) that pushes aiui events into
 * a Claude Code session by declaring the experimental `claude/channel`
 * capability.
 *
 * @packageDocumentation
 */

export {
  type ChannelConnection,
  type ChannelConnectionOptions,
  type ChannelErrorMessage,
  type ChannelFormat,
  type ChannelResponse,
  createChannelConnection,
  type FormatRegistry,
  type MessageMeta,
  type PushMessage,
  pushError,
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
export {
  type ChunkDescriptor,
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
export type { FrameLogEntry, FrameLogSink } from "./frame-log";
export { defaultFormatLoader, type FormatLoader } from "./hot";
export type {
  ChromeDevtoolsInfo,
  LaunchInfo,
  OpenAiKeyStatus,
} from "./launch-info";
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
export { augmentTextPrompt, defaultFormats, textConcatFormat } from "./processors";
export {
  openRealtimeSession,
  type RealtimeCallbacks,
  type RealtimeResult,
  type RealtimeSession,
  type RealtimeSessionOptions,
  type RealtimeSocket,
  type RealtimeSocketFactory,
  type RealtimeSocketHandlers,
  type TranscriptWord,
} from "./realtime";
export { type SendResult, sendPromptByTag } from "./send";
export {
  type SendPromptWsOptions,
  sendPromptWsByTag,
  type WsSendResult,
} from "./send-ws";
export { type ChannelServerOptions, createChannelServer } from "./server";
export {
  type SessionClientMessage,
  SessionHub,
  type SessionHubOptions,
  type SessionPeerInfo,
  type SessionServerMessage,
  type SessionSummary,
} from "./session-hub";
export type { MountedSidecar, Sidecar, SidecarContext } from "./sidecar";
export {
  type OpenAiSpeakerOptions,
  openaiSpeaker,
  type Speaker,
  type SpeakInput,
  type SpeechResult,
} from "./speak";
export type { FetchLike } from "./transcribe";
export {
  type ChannelReload,
  type PromptHandler,
  type ReloadSummary,
  startWebServer,
  type WebServer,
  type WebServerOptions,
} from "./web";

/** The published package name — handy for smoke tests. */
export const name = "@habemus-papadum/aiui-claude-channel";
