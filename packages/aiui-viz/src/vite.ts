/**
 * vite.ts — THE aiui Vite plugin (`@habemus-papadum/aiui-viz/vite`), home of
 * the whole build-time integration since the 2026-07-14 restructure. One
 * plugin, two jobs — and deliberately nothing else:
 *
 *  1. **The source-locator compiler pass** (#source-locator, moved here from
 *     the dev overlay). It applies to serve AND build: factory identity
 *     injection is load-bearing (durable cells need their `{name, loc}`
 *     identity in production), so a build that violates the pass's
 *     expectations FAILS in prod exactly as it would in dev. What is dev-only
 *     is the EMISSION of instrumentation: the `data-source-loc` DOM stamps
 *     default to `command === "serve"` (owner, 2026-07-14 — production
 *     bundles ship clean of machine paths; pass `stampJsx: true` to keep them
 *     deliberately).
 *  2. **The dev-only `sourceRoot` seed**: a tiny HTML script setting
 *     `window.__AIUI__.sourceRoot` so the locator's relative stamps can be
 *     absolutized into the paths a prompt carries. Build-time knowledge,
 *     dev-only by the same rule as the stamps it serves.
 *
 * What this plugin deliberately does NOT do (the old overlay plugin's magic,
 * retired): no channel-port injection, no page-side `/tools` dialing, no
 * session bus, no overlay UI mounting. The `window.__AIUI__` global itself is
 * the RUNTIME's job now (see ./aiui-global — it exists in production too),
 * and channel connectivity arrives from OUTSIDE, via the intent client (the
 * Chrome extension or the CDP tier), never from the app.
 */

import type { Plugin } from "vite";
import {
  defaultFactories,
  type FactorySpec,
  type SourceLocatorViteOptions,
  sourceLocatorVite,
} from "#source-locator";

// Configs import factory helpers from this one subpath.
export {
  cellFactory,
  defaultFactories,
  type FactorySpec,
  optionsFactory,
  type SourceLocatorOptions,
  type SourceLocatorViteOptions,
  sourceLocatorBabel,
  sourceLocatorVite,
} from "#source-locator";

export interface AiuiPluginOptions {
  /**
   * The locator pass's options (factories, stampJsx, include/exclude).
   * `true`/omitted = defaults; `false` disables the pass entirely (rare —
   * durable factory identity dies with it).
   */
  locator?: boolean | SourceLocatorViteOptions;
  /**
   * The app's source root for absolutizing stamps (dev-only injection);
   * defaults to the Vite root at config-resolve time.
   */
  sourceRoot?: string;
}

/** The dev-only `sourceRoot` seed (see the module doc). */
function sourceRootSeed(explicit: string | undefined): Plugin {
  let root: string | undefined = explicit;
  return {
    name: "aiui:source-root",
    apply: "serve",
    configResolved(config) {
      root ??= config.root;
    },
    transformIndexHtml() {
      if (root === undefined) {
        return;
      }
      return [
        {
          tag: "script",
          injectTo: "head-prepend" as const,
          children: `(window.__AIUI__ ??= { v: 1, frames: [] }).sourceRoot = ${JSON.stringify(root)};`,
        },
      ];
    },
  };
}

/**
 * The aiui integration for an app's Vite config:
 *
 * ```ts
 * import aiui from "@habemus-papadum/aiui-viz/vite";
 * export default defineConfig({ plugins: [aiui(), solid()] });
 * ```
 *
 * Order matters: `aiui()` comes BEFORE the Solid plugin so the locator's
 * `pre`-phase Babel pass sees the original JSX.
 */
export function aiui(options: AiuiPluginOptions = {}): Plugin[] {
  const plugins: Plugin[] = [];
  if (options.locator !== false) {
    const locatorOptions: SourceLocatorViteOptions =
      options.locator === undefined || options.locator === true
        ? { factories: defaultFactories() as FactorySpec[] }
        : options.locator;
    plugins.push(sourceLocatorVite(locatorOptions));
  }
  plugins.push(sourceRootSeed(options.sourceRoot));
  return plugins;
}

export default aiui;
