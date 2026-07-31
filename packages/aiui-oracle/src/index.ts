/**
 * The oracle — a realtime voice control surface for aiui apps: a chromeless
 * session engine (pluggable transport + key source, one normalized ledger)
 * plus opt-in widgets. Contract of record: docs/proposals/aiui-oracle.md.
 */

export type { ControlSurfaceToolsOptions, RegistryToolsOptions } from "./aiui-tools";
export {
  controlValueSchema,
  onControlSurfaceChange,
  toolsFromAiuiRegistry,
  toolsFromControlSurface,
} from "./aiui-tools";
export type { StandardKeySourcesOptions } from "./keys";
export {
  cachingKeySource,
  chainKeySource,
  devKeySource,
  mintClientSecret,
  mintingKeySource,
  OPENAI_BASE_URL,
  PASTED_KEY_STORAGE_KEY,
  pasteKeySource,
  standardKeySources,
  staticKeySource,
} from "./keys";
export type { ParamSpec, ParamWhen } from "./params";
export {
  CONSTRAINT_PARAMS,
  getPath,
  pruneTurnDetection,
  rowDrifts,
  SESSION_PARAMS,
  setPath,
  specApplies,
  TURN_DETECTION,
  TURN_DETECTION_TYPE,
} from "./params";
export type { WeaveOptions } from "./prompt";
export { ORACLE_BASE_PERSONA, weaveInstructions } from "./prompt";
export type { OracleSessionOptions, OracleState } from "./session";
export { OracleSession } from "./session";
export type {
  FirstReplyGuard,
  InputTranscription,
  KeySource,
  LedgerBody,
  LedgerEntry,
  NoiseReduction,
  OracleAudio,
  OracleAudioInput,
  OracleAudioOutput,
  OracleConfig,
  OracleCredential,
  OracleStatus,
  OracleTool,
  OracleTransport,
  SemanticVad,
  ServerVad,
  TransportCapabilities,
  TransportConnectOptions,
  TransportHandle,
  TurnDetection,
  UsageTotals,
} from "./types";
export {
  DEFAULT_FIRST_REPLY_MAX_MS,
  DEFAULT_FIRST_REPLY_PAD_MS,
  DEFAULT_INPUT_TRANSCRIPTION_MODEL,
  DEFAULT_ORACLE_MODEL,
  DEFAULT_ORACLE_VOICE,
  DEFAULT_PARK_AFTER_IDLE_SECONDS,
} from "./types";
export type { WebRtcTransportOptions } from "./webrtc";
export { WEBRTC_CAPABILITIES, webRtcTransport } from "./webrtc";
