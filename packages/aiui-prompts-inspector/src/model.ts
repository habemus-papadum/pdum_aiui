/** Headless inspection state for custom renderers. No Solid, DOM, or parser runtime imports. */
export { InspectorController } from "./controller.ts";
export {
  type InspectionBinding,
  type InspectionDocument,
  type InspectionLoadOptions,
  loadInspection,
} from "./history.ts";
export type { OutputRange } from "./preview.ts";
export {
  canonicalText,
  comparePrompts,
  createState,
  descendants,
  foldedRanges,
  type InspectorState,
  ownersOfRange,
  type PromptComparison,
  parentChain,
  rangeFoldStatus,
  visibleFolds,
} from "./state.ts";
