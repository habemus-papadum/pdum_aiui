/**
 * @habemus-papadum/aiui-intent-client — the greenfield intent client
 * (docs/proposals/intent-client/README.md): a detached plain-page panel
 * built Solid-native on the aiui-viz mode engine, host-agnostic behind the
 * PageTransport/SurfaceTargeting/CaptureSource seam. The MV3 extension is a
 * shell added LAST (ExtensionBus + a static build); the FakeBus makes every
 * behavior harness-testable from the first commit.
 *
 * Layers:
 *  - spec.ts    — the machine as data (regions/commands/esc/excludes)
 *  - claims.ts  — outbound obligations, derived (no hand-called syncs)
 *  - keys.ts    — the in-turn grammar → engine commands
 *  - caps.ts    — the command bar, projected
 *  - client.ts  — one constructor wiring all of it over an injected host
 *  - fake-bus.ts— the in-memory host (tests + the dev harness)
 */

export { activationGesture } from "./activation";
export { configBar, intentBar } from "./caps";
export { type ClaimLaneOptions, intentClaims } from "./claims";
export {
  createIntentClient,
  type IntentClient,
  type IntentClientConfig,
  type IntentLanes,
} from "./client";
export * as intentConfig from "./config";
export { installConfigAutoSave, loadConfigBase } from "./config-store";
export { type FakeBus, fakeBus } from "./fake-bus";
export { hintsFor, type KeyVerdict, keyStack, keyVerdict, turnLayer } from "./keys";
export {
  type ChannelLanes,
  type ChannelLanesConfig,
  createChannelLanes,
  currentThreadEvents,
  type OpenThread,
  panelIntentConfig,
  sessionStorageMirror,
  type TurnMirror,
} from "./lanes";
export {
  type BusPeer,
  type BusPhase,
  type BusState,
  type ChannelHealth,
  connectSessionBus,
  INITIAL_BUS_STATE,
  probeChannel,
  reduceBusMessage,
  resolveChannelPort,
  type SessionBusClient,
} from "./session";
export { type IntentContext, initialContext, intentSpec } from "./spec";
export type {
  CaptureSource,
  HeldStream,
  IntentHost,
  PageCapability,
  PageEvent,
  PageTransport,
  PanelShot,
  RingState,
  SurfaceTargeting,
} from "./transport";
