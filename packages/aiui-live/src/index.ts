/**
 * @habemus-papadum/aiui-live — the live oracle: a full-duplex voice front
 * (OpenAI GPT-Live) whose thinking is DELEGATED to a backend you choose — a
 * scripted stand-in, a Responses model with the page's tools, or Claude Code
 * on a server. This barrel is the browser-safe core; Solid widgets live at
 * `./widgets`, node-only pieces (WebSocket transport, the session broker +
 * delegation relay, speech synthesis) at `./node`, the Claude Code delegator
 * at `./claude`, and the Vite dev-server plugin at `./vite`.
 *
 * Contract of record: docs/proposals/oracle-live.md.
 */

export type {
  DirectBrokerOptions,
  ServerBrokerOptions,
  SessionAnswer,
  SessionBroker,
  StandardBrokersOptions,
} from "./brokers";
export {
  browserKey,
  chainBroker,
  devKey,
  devKeyBroker,
  directBroker,
  PASTED_KEY_STORAGE_KEY,
  pasteKeyBroker,
  serverBroker,
  standardBrokers,
} from "./brokers";
export { formatSeconds, formatUsd, LIVE_USD_PER_MINUTE, priceLiveSeconds } from "./cost";
export type { ScriptedDelegatorOptions } from "./delegators/fake";
export { echoDelegator, scriptedDelegator } from "./delegators/fake";
export type { RelayClientFrame, RelayServerFrame } from "./delegators/relay-protocol";
export { decodeFrame, encodeFrame } from "./delegators/relay-protocol";
export type { RemoteDelegatorOptions } from "./delegators/remote";
export { remoteDelegator } from "./delegators/remote";
export type { ResponsesDelegatorOptions } from "./delegators/responses";
export { requestMessage, responsesDelegator } from "./delegators/responses";
export type { BackendPromptOptions, LivePromptOptions } from "./prompt";
export {
  backendPrompt,
  backendToolsFromTools,
  DEFAULT_BACKCHANNEL_POLICY,
  DEFAULT_BACKEND_TOOLS,
  DEFAULT_DELEGATE_WHEN,
  DEFAULT_DONT_DELEGATE_WHEN,
  DEFAULT_INTERRUPTION_POLICY,
  DELEGATION_CLOSING,
  LIVE_BASE_PERSONA,
  livePrompt,
} from "./prompt";
export type {
  AppendEvent,
  AppendedEvent,
  AppendKind,
  DelegationCreatedEvent,
  FunctionCallItem,
  LiveAudioConfig,
  LiveBackendTool,
  LiveCloseReason,
  LiveDelegationConfig,
  LiveDelegationRecord,
  LiveErrorEvent,
  LiveEvent,
  LiveG711Format,
  LiveInputMessage,
  LivePcmFormat,
  LiveResponsesDelegation,
  LiveServerEvent,
  LiveSessionConfig,
  LiveSessionRecord,
  OutputAudioDeltaEvent,
  ReasoningEffort,
  ResponseEventEvent,
  SessionClosedEvent,
  SessionStartedEvent,
  SessionUpdatedEvent,
  SessionUsageUpdatedEvent,
  TranscriptDeltaEvent,
} from "./protocol";
export {
  APPEND_EVENT,
  APPEND_TOKEN_LIMIT,
  APPENDED_EVENT,
  appendEvent,
  appendKindOfAck,
  DEFAULT_LIVE_VOICE,
  functionCallFromResponseEvent,
  functionCallOutputEvents,
  LIVE_BASE_URL,
  LIVE_MODEL,
  LIVE_SESSIONS_PATH,
  LIVE_VOICES,
  LIVE_WS_URL,
  outputTextFromResponseEvent,
  typedInputEvents,
} from "./protocol";
export type { AppendReceipt, LiveConfig, LiveSessionOptions } from "./session";
export {
  appendedEventType,
  DEFAULT_FAILURE_TEXT,
  DEFAULT_IDLE_CLOSE_SECONDS,
  DEFAULT_PROGRESS_AFTER_MS,
  DEFAULT_PROGRESS_TEXT,
  LiveSession,
  RESEED_TOKEN_BUDGET,
} from "./session";
export { approxTokens, chunkForAppend } from "./tokens";
export {
  DEFAULT_GAP_MS,
  groupUtterances,
  interleave,
  joinFragments,
  TranscriptTrack,
} from "./transcript";
export type {
  DelegationRequest,
  Delegator,
  LedgerDir,
  LedgerEntry,
  LedgerKind,
  LiveCaptions,
  LivePromptSlots,
  LiveState,
  LiveStatus,
  LiveTask,
  LiveTool,
  LiveToolSpec,
  LiveTransport,
  TaskAppend,
  TaskStatus,
  TranscriptSegment,
  TranscriptSnapshot,
  TransportConnectOptions,
  TransportHandle,
  Utterance,
} from "./types";
export { backendToolFor, runTool, taskTimings, toolSpec } from "./types";
export type { WebRtcTransportOptions } from "./webrtc";
export { ECHO_SAFE_AUDIO, webRtcTransport } from "./webrtc";
