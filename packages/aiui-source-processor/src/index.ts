/**
 * index.ts — THE aiui Vite plugin (`@habemus-papadum/aiui-source-processor`),
 * home of the whole build-time integration. Extracted into its own package
 * (from `aiui-viz/vite`, itself moved from the retired dev overlay in the
 * 2026-07-14 restructure) so the source transform is a standalone, testable
 * library. One
 * plugin, two jobs — and deliberately nothing else:
 *
 *  1. **The source-locator compiler pass** (./source-locator). It applies to
 *     serve AND build: factory identity
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
 * the RUNTIME's job now (see `aiui-viz/src/aiui-global.ts` — it exists in
 * production too), and channel connectivity arrives from OUTSIDE, via the
 * intent client (the Chrome extension or the CDP tier), never from the app.
 */

import {
  type ResolveVendorKeysOptions,
  resolveVendorKeys,
  type VendorProvider,
  vendorKeysModeSelf,
} from "@habemus-papadum/aiui-util";
import type { Plugin } from "vite";
import {
  defaultFactories,
  type FactorySpec,
  type SourceLocatorViteOptions,
  sourceLocatorVite,
} from "./source-locator.ts";

// The locator pass's config surface; `defaultFactories` is how a custom
// factories list extends (rather than replaces) the defaults.
export {
  defaultFactories,
  type FactorySpec,
  type SourceLocatorOptions,
  type SourceLocatorViteOptions,
  sourceLocatorBabel,
  sourceLocatorVite,
} from "./source-locator.ts";

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
  /**
   * OPT-IN, DEV-SERVE ONLY: inject these vendors' API keys into served pages
   * as `window.__AIUI__.devKeys` (e.g. `devKeys: ["openai"]` for an embedded
   * oracle). Resolution is the house vendor-key machinery (aiui-util): a
   * source checkout honors the environment first, then the OS vault; an
   * installed aiui reads the vault only (`aiui keys set <provider>`). The
   * seeding plugin applies to serve alone — a production bundle structurally
   * cannot contain a key — but every DEV-SERVED page carries it (LAN-readable
   * under `server.host: true`), which is why this is never on by default.
   */
  devKeys?: VendorProvider[];
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
          children: `(window.__AIUI__ ??= { v: 1 }).sourceRoot = ${JSON.stringify(root)};`,
        },
      ];
    },
  };
}

/**
 * The dev-only `devKeys` seed (see {@link AiuiPluginOptions.devKeys}). The
 * resolver parameter is the test seam; the default is the house machinery.
 * Keys resolve ONCE per dev-server run (vault shell-outs must not ride every
 * page load); missing/skipped providers warn LOUDLY with the remedy.
 */
export function devKeysSeed(
  providers: VendorProvider[],
  resolve: (
    options: ResolveVendorKeysOptions,
  ) => ReturnType<typeof resolveVendorKeys> = resolveVendorKeys,
): Plugin {
  let warn: (message: string) => void = (message) => console.warn(message);
  let held: Promise<Record<string, string>> | undefined;
  const resolveOnce = (): Promise<Record<string, string>> => {
    held ??= (async () => {
      // Self-provenance (never a by-name lookup from aiui-util's vantage):
      // under pnpm's strict layout a workspace package is invisible to a
      // sibling's node_modules chain, and the by-name form 500'd a consuming
      // dev server on every page load whenever no incidental NODE_PATH
      // rescued it (found live 2026-08-24, pitch deck).
      const mode = vendorKeysModeSelf({
        importMetaUrl: import.meta.url,
        packageName: "@habemus-papadum/aiui-source-processor",
      });
      const resolved = await resolve({ mode, onWarn: warn });
      const keys: Record<string, string> = {};
      for (const provider of providers) {
        const key = resolved[provider];
        if (key.value !== undefined) {
          keys[provider] = key.value;
        } else {
          warn(
            `[aiui] devKeys: no ${key.label} key (${key.source}) — export ${key.envVar} ` +
              `or \`aiui keys set ${provider}\`; the page gets no ${provider} dev key`,
          );
        }
      }
      return keys;
    })();
    return held;
  };
  return {
    name: "aiui:dev-keys",
    apply: "serve",
    configResolved(config) {
      warn = (message) => config.logger.warn(message);
    },
    async transformIndexHtml() {
      const keys = await resolveOnce();
      if (Object.keys(keys).length === 0) {
        return [];
      }
      return [
        {
          tag: "script",
          injectTo: "head-prepend" as const,
          children: `(window.__AIUI__ ??= { v: 1 }).devKeys = ${JSON.stringify(keys)};`,
        },
      ];
    },
  };
}

/**
 * The aiui integration for an app's Vite config:
 *
 * ```ts
 * import aiui from "@habemus-papadum/aiui-source-processor";
 * export default defineConfig({ plugins: [aiui(), solid()] });
 * ```
 *
 * Order matters: `aiui()` comes BEFORE the Solid plugin so the locator's
 * `pre`-phase Babel pass sees the original JSX.
 */
export function aiui(options: AiuiPluginOptions = {}): Plugin[] {
  const plugins: Plugin[] = [];
  if (options.locator !== false) {
    let locatorOptions: SourceLocatorViteOptions;
    if (options.locator === undefined || options.locator === true) {
      locatorOptions = { factories: defaultFactories() as FactorySpec[] };
    } else {
      locatorOptions = {
        ...options.locator,
        factories: options.locator.factories ?? (defaultFactories() as FactorySpec[]),
      };
    }
    plugins.push(sourceLocatorVite(locatorOptions));
  }
  plugins.push(sourceRootSeed(options.sourceRoot));
  if (options.devKeys !== undefined && options.devKeys.length > 0) {
    plugins.push(devKeysSeed(options.devKeys));
  }
  return plugins;
}

export default aiui;
