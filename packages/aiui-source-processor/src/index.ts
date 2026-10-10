/**
 * index.ts — THE aiui Vite plugin (`@habemus-papadum/aiui-source-processor`),
 * home of the whole build-time integration. Extracted into its own package
 * (from `aiui-viz/vite`, itself moved from the retired dev overlay in the
 * 2026-07-14 restructure) so the source transform is a standalone, testable
 * library. One
 * plugin, a few build-time jobs — the locator pass, the dev source listing,
 * and the opt-ins (`devKeys`, `sources: "ship"`, `duckdbAssets`) — and
 * deliberately nothing else:
 *
 *  1. **The source-locator compiler pass** (./source-locator). It applies to
 *     serve AND build, both halves: factory identity injection is
 *     load-bearing (durable cells need their `{name, loc}` identity in
 *     production), so a build that violates the pass's expectations FAILS in
 *     prod exactly as it would in dev; and the `data-source-loc` DOM stamps
 *     ride into builds too (owner, 2026-10-09 — a selection on the published
 *     page attributes like one on the dev server; the stamps are
 *     root-relative, never machine paths), with `stampJsx: false` as the
 *     opt-out. (They were serve-only from 2026-07-14 until then.)
 *  2. **The dev-only `sourceRoot` seed**: a tiny HTML script setting
 *     `window.__AIUI__.sourceRoot` so the locator's relative stamps can be
 *     absolutized into the paths an editor opens. A machine path never
 *     ships; an explicit URL (`sourceRoot` option) seeds every mode.
 *  3. **The page's own source** (./dev-sources, ./ship-sources): the dev
 *     server lists the workspace files it serves; a build made with
 *     `sources: "ship"` carries them. Either way `window.__AIUI__.sources`
 *     names the manifest and aiui-viz's `source`/`sources` tools read it.
 *
 * What this plugin deliberately does NOT do (the old overlay plugin's magic,
 * retired): no channel-port injection, no page-side `/tools` dialing, no
 * session bus, no overlay UI mounting. The `window.__AIUI__` global itself is
 * the RUNTIME's job now (see `aiui-viz/src/aiui-global.ts` — it exists in
 * production too), and any agent connectivity arrives from OUTSIDE — a host
 * that drives the page over CDP or an extension — never from the app.
 */

import type { Plugin } from "vite";
import { type ResolvedDevKeys, resolveDevKeys, type VendorProvider } from "./dev-keys.ts";
import { devSources } from "./dev-sources.ts";
import { type DuckdbAssetsOptions, duckdbAssets } from "./duckdb-assets.ts";
import { shipSources } from "./ship-sources.ts";
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
   * oracle). A key comes from the ENVIRONMENT of the process that starts the
   * dev server, and nowhere else — `OPENAI_API_KEY`, `ELEVEN_LABS_API_KEY`,
   * `GEMINI_API_KEY`, `MOTHERDUCK_BROWSER_TOKEN` (the table in ./dev-keys):
   * a `.env` in the checkout with direnv, or an `export` in the shell. The
   * seeding plugin applies to serve alone — a production bundle structurally
   * cannot contain a key — but every DEV-SERVED page carries it (LAN-readable
   * under `server.host: true`), which is why this is never on by default.
   */
  devKeys?: VendorProvider[];
  /**
   * Self-host the installed `@duckdb/duckdb-wasm` binaries at the MotherDuck
   * client's layout (`<base>duckdb-wasm-assets/<version>/…`) — served in dev,
   * emitted unhashed into the build — and tell the page where they are
   * (`window.__AIUI__.duckdbAssets`; aiui-viz's `duckdbAssetBundles()` reads
   * it back). `true` for the defaults; an object for `brotli` siblings. See
   * ./duckdb-assets.ts.
   */
  duckdbAssets?: boolean | DuckdbAssetsOptions;
  /**
   * `"ship"`: a production build carries its own source — every app file
   * (the root plus the locator's `stampRoots`; never node_modules) emitted
   * unchanged under `__aiui/src/` with a manifest, and the page told where
   * (`window.__AIUI__.sources`), so aiui-viz's `source` tool reads code on
   * the published site as it does on a dev server (which lists its own
   * workspace without any option — see ./dev-sources). This PUBLISHES the
   * source; off by default, for sites whose code is public anyway. Pair it
   * with a `sourceRoot` URL so prod stamps link somewhere (see ./ship-sources).
   */
  sources?: "ship";
}

/**
 * The `sourceRoot` seed (see the module doc): dev-only when it is the Vite
 * root (a machine path never ships); an EXPLICIT root — a URL, for a build
 * that ships its sources and keeps its stamps — seeds every mode.
 */
function sourceRootSeed(explicit: string | undefined): Plugin {
  let root: string | undefined = explicit;
  return {
    name: "aiui:source-root",
    ...(explicit === undefined ? { apply: "serve" as const } : {}),
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
 * resolver parameter is the test seam; the default reads the environment
 * (./dev-keys). Keys resolve ONCE per dev-server run — the environment the
 * server started with IS the environment, a page load never re-reads it —
 * and every missing provider warns LOUDLY with the remedy.
 */
export function devKeysSeed(
  providers: VendorProvider[],
  resolve: (env: NodeJS.ProcessEnv) => ResolvedDevKeys = resolveDevKeys,
): Plugin {
  let warn: (message: string) => void = (message) => console.warn(message);
  let held: Record<string, string> | undefined;
  const resolveOnce = (): Record<string, string> => {
    if (held !== undefined) {
      return held;
    }
    const resolved = resolve(process.env);
    const keys: Record<string, string> = {};
    for (const provider of providers) {
      const key = resolved[provider];
      if (key.value !== undefined) {
        keys[provider] = key.value;
      } else {
        warn(
          `[aiui] devKeys: no ${key.label} key — export ${key.envVar} ` +
            "(a `.env` in the checkout works with direnv); " +
            `the page gets no ${provider} dev key`,
        );
      }
    }
    held = keys;
    return keys;
  };
  return {
    name: "aiui:dev-keys",
    apply: "serve",
    configResolved(config) {
      warn = (message) => config.logger.warn(message);
    },
    transformIndexHtml() {
      const keys = resolveOnce();
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
  const locator = typeof options.locator === "object" ? options.locator : undefined;
  const roots = locator?.stampRoots !== undefined ? { roots: locator.stampRoots } : {};
  plugins.push(devSources(roots)); // serve-only: the workspace listing
  if (options.sources === "ship") {
    plugins.push(shipSources(roots));
  }
  if (options.devKeys !== undefined && options.devKeys.length > 0) {
    plugins.push(devKeysSeed(options.devKeys));
  }
  if (options.duckdbAssets !== undefined && options.duckdbAssets !== false) {
    plugins.push(duckdbAssets(options.duckdbAssets === true ? {} : options.duckdbAssets));
  }
  return plugins;
}

export {
  type ResolvedDevKey,
  type ResolvedDevKeys,
  resolveDevKeys,
  VENDOR_KEYS,
  type VendorKeySpec,
  type VendorProvider,
} from "./dev-keys.ts";
export { type DevSourcesOptions, devSources, listSourceFiles } from "./dev-sources.ts";
export {
  DUCKDB_ASSET_FILES,
  DUCKDB_ASSETS_DIR,
  type DuckdbAssetsLayout,
  type DuckdbAssetsOptions,
  duckdbAssetPath,
  duckdbAssets,
  locateDuckdbAssets,
} from "./duckdb-assets.ts";
export {
  SHIPPED_FILE,
  type ShipSourcesOptions,
  SOURCES_DIR,
  SOURCES_MANIFEST,
  type SourcesManifest,
  shippedPath,
  shipSources,
} from "./ship-sources.ts";

export default aiui;
