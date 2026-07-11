/**
 * @habemus-papadum/aiui-webext — shared runtime infrastructure for aiui Chrome
 * extensions (design: docs/proposals/browser-extension-intent-tool.md; spike
 * evidence: archive/extension-spikes/RESULTS.md).
 *
 * This barrel is the browser-side surface (relay, panes, indicator, offscreen
 * guard). The build-time config factory lives at the `./vite` subpath — it
 * imports Node/build machinery and must not be pulled into extension bundles.
 */
export { type IndicatorHandle, type IndicatorState, mountIndicator } from "./indicator";
export { ensureOffscreenDocument } from "./offscreen";
export {
  injectPaneStyles,
  PANE_STYLES,
  Pane,
  type PaneProps,
  PaneStack,
} from "./panes";
export {
  fromRelayResult,
  isRelayEnvelope,
  type RelayEnvelope,
  type RelayHandler,
  type RelayResult,
  relayRequest,
  relayRequestTab,
  serveRelay,
  toRelayResult,
} from "./relay";
