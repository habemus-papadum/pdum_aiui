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
export { CHANNEL_CONFIG } from "./commands/config";
export {
  buildElevenLabsUrl,
  convertWords,
  DEFAULT_ELEVENLABS_MODEL,
  ELEVENLABS_COMMIT_FLOOR_MS,
  ELEVENLABS_ERROR_TYPES,
  ELEVENLABS_KEEPALIVE_MS,
  ELEVENLABS_REALTIME_URL,
  type ElevenLabsRealtimeSessionOptions,
  elevenLabsSocketFactory,
  isErrorType,
  openElevenLabsRealtimeSession,
} from "./elevenlabs-realtime";
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
export {
  createFrameLog,
  FRAME_LOG_LIMIT,
  type FrameLog,
  type FrameLogEntry,
  type FrameLogOptions,
  type FrameLogSink,
} from "./frame-log";
export {
  DEFAULT_GEMINI_LIVE_MODEL,
  GEMINI_LIVE_URL,
  type GeminiLiveSessionOptions,
  geminiLiveSocketFactory,
  type LiveFrameKind,
  openGeminiLiveSession,
  parseTimeLeftMs,
  WindowOrderingGuard,
} from "./gemini-live";
export {
  channelSourceDir,
  defaultFormatLoader,
  type FormatLoader,
  isSourceRun,
  loadModuleFresh,
  type WatchFn,
  type WatchOptions,
  watchChannelSource,
} from "./hot";
export {
  createIntentV1Format,
  type IntentV1Options,
  intentV1Format,
  type LoweredMessage,
  type LoweredPromptMessage,
  type SpeechMessage,
} from "./intent-v1";
export {
  type ChromeDevtoolsInfo,
  type LaunchInfo,
  type OpenAiKeyStatus,
  parseLaunchInfo,
} from "./launch-info";
export { dirRank, type ListOptions, listMcpServers, sortServers } from "./list";
export {
  SELECTION_EXCERPT_CHARS,
  type SelectionEntry,
  selectionInjectionLabel,
  selectionRetractionLabel,
} from "./live-resolve";
export {
  LINTER_INSTRUCTIONS,
  type LinterToolCall,
  type LiveCapabilities,
  type LiveSession,
  type LiveSessionCallbacks,
} from "./live-session";
export {
  type LoadSidecarsOptions,
  loadSidecars,
  parseSidecarDescriptors,
  type SidecarDescriptor,
  type SidecarImport,
} from "./load-sidecars";
export {
  DEFAULT_OPENAI_LIVE_MODEL,
  type OpenAiLiveSessionOptions,
  openOpenAiLiveSession,
} from "./openai-live";
export {
  formatPageToolsChanged,
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
  DEFAULT_REALTIME_MODEL,
  OPENAI_REALTIME_URL,
  openaiRealtimeSocketFactory,
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
export {
  DEFAULT_MAX_RESPONSES,
  DEFAULT_REALTIME_VOICE_MODEL,
  DEFAULT_VOICE_INSTRUCTIONS,
  DEFAULT_VOICE_TRANSCRIPTION_MODEL,
  OPENAI_REALTIME_VOICE_URL,
  openRealtimeVoiceSession,
  pcm16ToWav,
  REALTIME_VOICE_RATE,
  type RealtimeVoiceCallbacks,
  type RealtimeVoiceSession,
  type RealtimeVoiceSessionOptions,
  type VoiceAudioClip,
  type VoiceUserResult,
} from "./realtime-voice";
export { createJsonlRecorder, type JsonlRecorder } from "./recording";
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
  type SessionClientMessage,
  SessionHub,
  type SessionHubOptions,
  type SessionPeerInfo,
  type SessionServerMessage,
  type SessionSummary,
} from "./session-hub";
export type { MountedSidecar, Sidecar, SidecarContext } from "./sidecar";
export {
  mockSpeaker,
  type OpenAiSpeakerOptions,
  openaiSpeaker,
  type Speaker,
  type SpeakInput,
  type SpeechResult,
} from "./speak";
export {
  createTransportStats,
  type FrameStat,
  type TransportSnapshot,
  type TransportStats,
} from "./stats";
export {
  DEFAULT_SUMMARY_MODEL,
  type OpenAiSummarizerOptions,
  openaiSummarizer,
  SUMMARY_SYSTEM_PROMPT,
  type Summarizer,
  summaryPromptInput,
} from "./summarize";
export {
  type ChannelInfo,
  type ChannelToolHandles,
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
  sessionLabel,
  type TraceHandle,
  type TraceManifest,
  type TraceStage,
  type TraceStageKind,
  type TraceStore,
  traceBlobPath,
} from "./trace";
export { type TracingThreadContext, traceOf, withTracing } from "./tracing";
export {
  audioExtensionForMime,
  type FetchLike,
  mockTranscriber,
  type OpenAiTranscriberOptions,
  openaiTranscriber,
  type TranscribeInput,
  type Transcriber,
  type TranscriptResult,
} from "./transcribe";
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
