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
export {
  cachingKeySource,
  chainKeySource,
  mintClientSecret,
  mintingKeySource,
  OPENAI_BASE_URL,
  PASTED_KEY_STORAGE_KEY,
  pasteKeySource,
  staticKeySource,
} from "./keys";
export type { WeaveOptions } from "./prompt";
export { ORACLE_BASE_PERSONA, weaveInstructions } from "./prompt";
export type { OracleSessionOptions, OracleState } from "./session";
export { OracleSession } from "./session";
export type {
  KeySource,
  LedgerBody,
  LedgerEntry,
  OracleConfig,
  OracleCredential,
  OracleStatus,
  OracleTool,
  OracleTransport,
  OracleTurnMode,
  TransportCapabilities,
  TransportConnectOptions,
  TransportHandle,
  UsageTotals,
} from "./types";
export {
  DEFAULT_INPUT_TRANSCRIPTION_MODEL,
  DEFAULT_ORACLE_MODEL,
  DEFAULT_ORACLE_VOICE,
} from "./types";
export type { WebRtcTransportOptions } from "./webrtc";
export { WEBRTC_CAPABILITIES, webRtcTransport } from "./webrtc";
