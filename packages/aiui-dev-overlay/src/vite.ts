/**
 * The Vite plugin that puts the intent tool into the page: `aiuiDevOverlay()`
 * in an app's Vite config is the whole integration — it injects the running
 * channel server's port *and* auto-mounts the widget at serve time. No app
 * code required (manual `mountIntentTool` stays available for custom
 * modalities and non-Vite setups).
 *
 * Two injections, both dev-server-only (`apply: "serve"` — the overlay can
 * never leak into a production build):
 *
 *  1. **The context seed** — an inline script that writes the channel port
 *     (`window.__AIUI__.port`) and the app's source root
 *     (`window.__AIUI__.sourceRoot`) before any module runs. Why not let the
 *     widget read `import.meta.env` itself? That's the subtle part:
 *     `import.meta.env.*` is not a runtime lookup; every bundler substitutes
 *     it when *it* compiles the file. This package ships prebuilt, and its own
 *     library build already replaced `import.meta.env` with an empty object
 *     frozen into `dist/` — so by the time a consumer's dev server serves that
 *     code there is no `import.meta.env` text left to substitute, and the
 *     consumer's `VITE_AIUI_PORT` can never reach it. The port must travel
 *     through a *runtime* channel: this plugin reads the env var in the
 *     dev-server process (where `aiui vite` exported it) and hands it to the
 *     page. See also "How the tool gets into the page" in the Web Intent Tool
 *     guide.
 *
 *  2. **The mount** — a `<script type="module">` pointing at a virtual module
 *     that imports the overlay package and calls `mountIntentTool`. The
 *     virtual module is generated per-request by *this* plugin inside the
 *     consumer's dev server, so it can embed the port as a literal — no
 *     env-substitution timing to get wrong. It mounts on window `load` and
 *     keeps the widget mounted if the app rebuilds its DOM (see `load()`).
 *     The same module also installs the page-tools bridge
 *     (`installToolsBridge` — `window.__AIUI__.tools` + the `/tools`
 *     websocket), so page toolkits registered with `agentToolkit` reach the
 *     agent as callable tools with zero app wiring.
 */
import type { Plugin } from "vite";
// Imported through the package-internal `#source-locator` subpath rather than a
// relative path. This node-side entry is externalized during a consumer's Vite
// config bundling and loaded by node's native ESM, which — unlike Vite/tsx
// transforms — can't resolve an extensionless relative import of a sibling
// `.ts`. The `#`-import (resolved via package.json `imports`, dev→src / publish→
// dist) carries no extension in the specifier, so it resolves cleanly for node
// and TypeScript in both the source-first dev shape and the published `dist`.
import { sourceLocatorVite } from "#source-locator";

// Re-exported from the `./vite` (node-side) subpath so the compile-time locator
// stays out of the browser bundle. Consumers usually enable it through
// `aiuiDevOverlay({ locator })` rather than wiring these directly.
export {
  type SourceLocatorOptions,
  type SourceLocatorViteOptions,
  sourceLocatorBabel,
  sourceLocatorVite,
} from "#source-locator";

/** The env var `aiui vite` exports to point the dev server at the channel. */
const PORT_ENV = "VITE_AIUI_PORT";

/** The overlay package the virtual mount module imports. */
const PKG = "@habemus-papadum/aiui-dev-overlay";

/**
 * The virtual module that performs the mount. Not `\0`-prefixed: the browser
 * requests it by URL (`/@id/…`), so the id must survive the round trip.
 */
const MOUNT_ID = "virtual:aiui-dev-overlay/mount";

export interface AiuiDevOverlayOptions {
  /**
   * Auto-mount the intent tool (default `true`). Set `false` to keep only the
   * port/source injection and mount from app code instead — needed when
   * passing custom modalities, which are functions and can't cross
   * vite.config. `false` also skips the tools bridge; call
   * `installToolsBridge()` from app code if you still want page tools
   * forwarded to the agent.
   */
  mount?: boolean;
  /**
   * The wire format the mounted tool speaks — selects the bundled modality
   * (default `"text-concat"`, currently the only one). This is where an app's
   * Vite config declares which message format its intent tool uses.
   */
  format?: string;
  /** Channel port to inject; defaults to `process.env.VITE_AIUI_PORT`. */
  port?: number | string;
  /**
   * The app's source root, injected as `window.__AIUI__.sourceRoot` and sent
   * to the channel server with every intent (so lowered prompts can say where
   * the page's code lives). Defaults to the resolved Vite root.
   */
  sourceRoot?: string;
  /**
   * Enable compile-time source-location stamping (opt-in, default off). When
   * on, `aiuiDevOverlay()` returns an ARRAY of plugins — a `"pre"` babel pass
   * that stamps every host JSX element with `data-source-loc` and (unless
   * disabled) injects `{ name, loc }` into cell-factory call sites — plus the
   * overlay plugin. Vite flattens nested plugin arrays, so
   * `plugins: [aiuiDevOverlay({ locator: true })]` keeps working.
   *
   * - `true` — JSX stamping and the default `cell()` call-site injection.
   * - `{ cellFactories }` — configure the call-site factory names; pass `[]`
   *   to keep JSX stamping only.
   *
   * ORDER MATTERS for JSX stamping: place `aiuiDevOverlay(...)` BEFORE your
   * framework's JSX plugin (e.g. `vite-plugin-solid`, which is also
   * `enforce: "pre"`) — same-enforce plugins run in array order, and the
   * locator must see JSX before the framework compiles each element into an
   * opaque template. The `cell()` half is order-independent (plain `.ts`).
   *
   * Requires `@babel/core` (an optional peer) as a devDependency of the app.
   * The locator's source-loc paths are relative to the same root injected as
   * `window.__AIUI__.sourceRoot` (this option's `sourceRoot`, else the Vite root).
   */
  locator?: boolean | { cellFactories?: string[] };
}

/**
 * Mount the aiui intent tool into every page this dev server serves, wired to
 * the running channel server:
 *
 * ```ts
 * import aiuiDevOverlay from "@habemus-papadum/aiui-dev-overlay/vite";
 * export default defineConfig({ plugins: [aiuiDevOverlay()] });
 * ```
 *
 * Launch through `aiui vite` so the channel port is known. Without one (env
 * unset) the widget still mounts and reports "no channel port" on send.
 */
export function aiuiDevOverlay(options: AiuiDevOverlayOptions = {}): Plugin | Plugin[] {
  const mount = options.mount ?? true;
  // The resolved Vite root, captured in configResolved — the sourceRoot
  // default. An explicit option always wins.
  let viteRoot: string | undefined;

  const resolvePort = (): number | undefined => {
    // `process` via globalThis: this file compiles under the package's
    // browser-only tsconfig (no node types), though it only ever runs in the
    // dev-server process.
    const raw =
      options.port ??
      (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[
        PORT_ENV
      ];
    const port = Number(raw);
    // Validated as a positive integer before interpolation, so the injected
    // script can carry nothing but a number.
    return Number.isInteger(port) && port > 0 ? port : undefined;
  };

  const resolveSourceRoot = (): string | undefined => options.sourceRoot ?? viteRoot;

  // JSON-encode a string for an inline <script>, `<` escaped so no value can
  // ever close the tag.
  const scriptString = (value: string): string => JSON.stringify(value).replace(/</g, "\\u003c");

  const overlay: Plugin = {
    name: "aiui:dev-overlay",
    apply: "serve",
    configResolved(config) {
      viteRoot = config.root;
    },
    // Deliberately NO `optimizeDeps.include` for the overlay: the dep
    // optimizer's cache is keyed by the lockfile, not by package contents, so
    // a workspace-linked overlay would be served stale after every rebuild.
    // The cost is Vite's standard one-time "new dependency discovered" reload
    // when a registry-installed consumer first loads the page (the scanner
    // can't see through the virtual mount module).
    resolveId(id) {
      return id === MOUNT_ID ? MOUNT_ID : undefined;
    },
    load(id) {
      if (id !== MOUNT_ID) {
        return undefined;
      }
      const port = resolvePort();
      // `force`: this module exists only while the dev server serves the page,
      // which *is* the dev-gate — the widget's own heuristic would wrongly
      // decline e.g. LAN-host (`--host`) serving.
      const args = [
        "force: true",
        ...(port === undefined ? [] : [`port: ${port}`]),
        ...(options.format === undefined ? [] : [`format: ${scriptString(options.format)}`]),
      ];
      const mountCall = `mountIntentTool({ ${args.join(", ")} })`;
      // Mount after `load`, not at module eval: this script runs before the
      // app's own modules, and apps that build their DOM during startup
      // (`document.body.innerHTML = …`) would sweep an eager mount away. The
      // observer remounts if the app rebuilds its DOM later — mountIntentTool
      // discards a handle whose host has left the document.
      //
      // The tools bridge, by contrast, installs at module eval: this script
      // precedes the app's modules in the document, so page toolkits find
      // `window.__AIUI__.tools` synchronously when they register. Without a
      // channel port it is a no-op.
      return [
        `import { installToolsBridge, mountIntentTool } from ${JSON.stringify(PKG)};`,
        `installToolsBridge(${port === undefined ? "" : `{ port: ${port} }`});`,
        `const mount = () => ${mountCall};`,
        "const keep = () => {",
        "  mount();",
        "  new MutationObserver(mount).observe(document.body, { childList: true });",
        "};",
        'if (document.readyState === "complete") keep();',
        'else window.addEventListener("load", keep, { once: true });',
        "",
      ].join("\n");
    },
    transformIndexHtml() {
      const port = resolvePort();
      const sourceRoot = resolveSourceRoot();
      const tags = [];
      const seed = [
        ...(port === undefined ? [] : [`window.__AIUI__.port = ${port};`]),
        ...(sourceRoot === undefined
          ? []
          : [`window.__AIUI__.sourceRoot = ${scriptString(sourceRoot)};`]),
      ];
      if (seed.length > 0) {
        tags.push({
          tag: "script",
          // head-prepend: inline scripts run during parse, before any module
          // script — the seed is readable before app code can mount anything.
          injectTo: "head-prepend" as const,
          // Keep the initializer shape in sync with getInstrumentation().
          children: [`window.__AIUI__ ??= { v: 1, frames: [] };`, ...seed].join(" "),
        });
      }
      if (mount) {
        tags.push({
          tag: "script",
          injectTo: "head" as const,
          attrs: { type: "module", src: `/@id/${MOUNT_ID}` },
        });
      }
      return tags;
    },
  };

  if (!options.locator) return overlay;

  // Opt-in locator: prepend the `"pre"` babel pass. Its source-loc paths share
  // the overlay's source root (explicit `sourceRoot`, else each captures the
  // resolved Vite root). Returning an array is transparent to consumers — Vite
  // flattens nested plugin arrays.
  const locatorOptions = options.locator === true ? {} : options.locator;
  return [
    sourceLocatorVite({ root: options.sourceRoot, cellFactories: locatorOptions.cellFactories }),
    overlay,
  ];
}

export default aiuiDevOverlay;
