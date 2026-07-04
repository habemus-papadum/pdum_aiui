/**
 * Browser-side dev overlay: a Shadow-DOM-isolated "floating tool surface" you
 * import and mount into any page. Dev-gated, double-injection safe, and
 * dependency-free.
 *
 * @packageDocumentation
 */

export type { DevOverlayHandle, DevOverlayOptions } from "./overlay";
export {
  isDevEnvironment,
  mountDevOverlay,
  unmountDevOverlay,
} from "./overlay";

/** The published package name — handy for smoke tests. */
export const name = "@habemus-papadum/aiui-dev-tool";
