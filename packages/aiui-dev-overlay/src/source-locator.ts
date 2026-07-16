/**
 * source-locator.ts — MOVED to its own package `@habemus-papadum/aiui-source-processor`
 * (extracted from `aiui-viz/vite`, itself moved from the dev overlay in the
 * 2026-07-14 restructure). This shim keeps the overlay's `#source-locator`
 * imports — and any direct consumer — working; new code imports
 * `@habemus-papadum/aiui-source-processor`.
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
} from "@habemus-papadum/aiui-source-processor";
