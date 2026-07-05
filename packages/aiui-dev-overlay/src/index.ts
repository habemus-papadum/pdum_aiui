/**
 * Browser-side aiui tools you import and mount into a page under development.
 * Dev-gated, double-injection safe, Shadow-DOM isolated, and dependency-free.
 *
 * Two mountables:
 *  - {@link mountIntentTool} — the **web intent tool** (layer 2): collects
 *    intent (text now; richer modalities later) and streams it to the running
 *    channel server for prompt lowering. Pluggable via {@link IntentModality}.
 *  - {@link mountDevOverlay} — the original inspection-overlay scaffold.
 *
 * For most apps neither mountable is called directly: the `./vite` subpath
 * exports the `aiuiDevOverlay()` Vite plugin, which *is* the integration — it
 * auto-mounts the intent tool into every served page and injects the channel
 * port (`window.__AIUI__.port`). It is a separate entry because it is Node
 * code, and because of the `import.meta.env` baking subtlety documented in
 * vite.ts.
 *
 * @packageDocumentation
 */

export { disposeDurable, durable } from "./durable";
export type { ClientMeta, FrameMetric, PageInstrumentation, TabInfo } from "./instrumentation";
export {
  collectClientMeta,
  getInstrumentation,
  recordFrameMetric,
  setChannelPort,
  TAB_DATASET_KEY,
} from "./instrumentation";
export type {
  IntentModality,
  IntentThread,
  IntentToolContext,
  IntentToolHandle,
  IntentToolOptions,
  OpenThreadOptions,
} from "./intent";
export { mountIntentTool, textModality, unmountIntentTool } from "./intent";
export type {
  CorrectionDiff,
  CorrectionInput,
  Corrector,
  ShotPixels,
  ShotSink,
  SpeechAudioElement,
  SpeechAudioFactory,
  SpeechClip,
  SpeechPlayerOptions,
  Transcriber,
  TranscriptResult,
} from "./multimodal";
export {
  AudioCapture,
  Ink,
  locateComponents,
  MULTIMODAL_STYLES,
  mockCorrector,
  mockTranscriber,
  multimodalModality,
  Preview,
  ShotTool,
  SpeechPlayer,
  SYSTEM_PROMPT,
} from "./multimodal";
export type { DevOverlayHandle, DevOverlayOptions } from "./overlay";
export {
  isDevEnvironment,
  mountDevOverlay,
  unmountDevOverlay,
} from "./overlay";
export type {
  OverlayReport,
  OverlayToolsDeps,
  OverlayToolsHandle,
  SetConfigResult,
  ThreadSocketState,
} from "./overlay-tools";
export { installOverlayTools, OVERLAY_TOOLS_NS } from "./overlay-tools";
export type {
  Ack,
  AttachmentChunk,
  FrameChunk,
  IntentSocket,
  JsonChunk,
  ServerMessage,
  WebSocketFactory,
  WebSocketLike,
} from "./protocol";
export { connectIntentSocket, encodeFrame, encodeJsonPayload, PROTOCOL_VERSION } from "./protocol";
export type {
  SelectionRect,
  SelectionSnapshot,
  SelectionWatcher,
  SelectionWatcherOptions,
} from "./selection";
export { installSelectionWatcher } from "./selection";
export type {
  BridgeTool,
  ToolsBridgeApi,
  ToolsBridgeOptions,
  ToolsSocketFactory,
  ToolsSocketLike,
} from "./tools-bridge";
export { canonicalToolsHash, installToolsBridge } from "./tools-bridge";
export type { RecoveredTurn } from "./turn-store";
export { intentTurnStore, TURN_STORAGE_KEY, TurnStore } from "./turn-store";

/** The published package name — handy for smoke tests. */
export const name = "@habemus-papadum/aiui-dev-overlay";
