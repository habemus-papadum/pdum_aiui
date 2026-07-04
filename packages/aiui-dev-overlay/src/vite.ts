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
 */
import type { Plugin } from "vite";

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
   * vite.config.
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
export function aiuiDevOverlay(options: AiuiDevOverlayOptions = {}): Plugin {
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

  return {
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
      return [
        `import { mountIntentTool } from ${JSON.stringify(PKG)};`,
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
}

export default aiuiDevOverlay;
