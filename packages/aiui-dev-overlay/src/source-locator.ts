/**
 * source-locator.ts — MOVED to `@habemus-papadum/aiui-viz` (the 2026-07-14
 * plugin restructure: the compiler pass serves the component layer, so it
 * lives with it). This shim keeps the overlay's `#source-locator` imports —
 * and any direct consumer — working; new code imports
 * `@habemus-papadum/aiui-viz/vite`.
 */
export {
  cellFactory,
  defaultFactories,
  type FactorySpec,
  optionsFactory,
  type SourceLocatorOptions,
  type SourceLocatorViteOptions,
  sourceLocatorBabel,
  sourceLocatorVite,
} from "@habemus-papadum/aiui-viz/vite";
