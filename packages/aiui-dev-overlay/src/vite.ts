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
import { type FactorySpec, sourceLocatorVite } from "#source-locator";
import type { IntentPipelineConfig } from "./intent-pipeline";

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

/**
 * The route this plugin serves the trace debugger at (always, in dev): the
 * shared debug-ui {@link TracesPane} against the injected channel port. The
 * intent tool's 🔍 links here (with `?session=` pinning the channel's session);
 * the channel's own `/debug` page remains the no-Vite standalone fallback.
 */
const DEBUG_ROUTE = "/__aiui/debug";

/** The virtual module that boots the trace debugger page (imports `./debug-ui`). */
const DEBUG_MOUNT_ID = "virtual:aiui-dev-overlay/debug";

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
   * Mount the turn-**hosting** intent tool (default `true`). Set `false` for a
   * pure *contributor* view — a git viewer, an external-editor bridge — that
   * joins the session bus (arming + preview + contributions) but must NOT host
   * its own turn: it keeps the port injection, the tools bridge, and
   * `installSessionBus`, and only skips `mountIntentTool`. Hosting from such a
   * view is actively wrong — its armed ink-capture layer would sit over the
   * view's UI and swallow clicks, and two hosts would race on the shared
   * `preview` slot. Pair with `session: { role: "code" }`. Distinct from
   * `mount: false`, which drops the whole module (bus included).
   */
  intentTool?: boolean;
  /**
   * The wire format the mounted tool speaks — selects the bundled modality set.
   * Omitted → the default `[multimodal (intent-v1), text]` (multimodal active,
   * text as the escape hatch). `"text-concat"` → text only; `"intent-v1"` →
   * multimodal only. This is where an app's Vite config declares its intent
   * tool's message format.
   */
  format?: string;
  /**
   * Client-side pipeline config for the bundled multimodal modality (talk mode,
   * ink fade, transcriber/corrector choice, arming rebind, research knobs).
   * JSON-serializable — it is embedded as a literal in the mount module and
   * rides the hello so a lowering trace records it. See `IntentPipelineConfig`.
   */
  intent?: Partial<IntentPipelineConfig>;
  /**
   * Actor label for trace provenance, embedded in the mount module and sent on
   * every intent hello as `meta.actor`. Omitted → `"human"`, unless the tab
   * opted in via the `aiui-actor` sessionStorage toggle (how an agent or CI
   * run labels the tab it drives — see ACTOR_STORAGE_KEY in the overlay's
   * instrumentation.ts for why this is an opt-in, not a webdriver heuristic).
   * Set it to force a fixed label for everything this dev server serves.
   */
  actor?: string;
  /**
   * The **session bus** role for the views this dev server serves — how a page
   * identifies itself to the other tabs of the session (`app`, `code`, `git`,
   * …). Every served page installs `window.__AIUI__.session`, dials the
   * channel's `/session` endpoint, and shares arming + prompt preview +
   * contributions with its peers. Omitted → role `"app"`; `false` skips the
   * bus entirely. (See docs/guide/multi-view-sessions.md.)
   */
  session?: false | { role?: string; label?: string };
  /** Channel port to inject; defaults to `process.env.VITE_AIUI_PORT`. */
  port?: number | string;
  /**
   * The app's source root, injected as `window.__AIUI__.sourceRoot` and sent
   * to the channel server with every intent (so lowered prompts can say where
   * the page's code lives). Defaults to the resolved Vite root.
   */
  sourceRoot?: string;
  /**
   * Enable the aiui compiler (opt-in, default off). When on,
   * `aiuiDevOverlay()` returns an ARRAY of plugins — a `"pre"` babel pass with
   * two halves — plus the overlay plugin. Vite flattens nested plugin arrays,
   * so `plugins: [aiuiDevOverlay({ locator: true })]` keeps working.
   *
   * The two halves have different lifecycles (source-locator.ts documents the
   * principles): **JSX stamping** (`data-source-loc` on host elements) is
   * dev-only instrumentation; **factory identity injection** (`{ name, loc,
   * description }` into `cell()`/`control()`/`action()` call sites, names
   * inferred from bindings, descriptions lifted from doc comments) is
   * LOAD-BEARING and runs in production builds too — a control's compiled-in
   * name is its durable key and tool identity.
   *
   * - `true` — JSX stamping plus the default factory table
   *   (`cell`/`control`/`action`).
   * - `{ factories }` — the full table (see `FactorySpec`); `[]` keeps JSX
   *   stamping only.
   * - `{ cellFactories }` — back-compat sugar: names treated as cell-shaped
   *   factories only.
   * - `{ stampJsx }` — override the per-command default (serve: on, build:
   *   off) for the instrumentation half.
   *
   * ORDER MATTERS for JSX stamping: place `aiuiDevOverlay(...)` BEFORE your
   * framework's JSX plugin (e.g. `vite-plugin-solid`, which is also
   * `enforce: "pre"`) — same-enforce plugins run in array order, and the
   * locator must see JSX before the framework compiles each element into an
   * opaque template. The factory half is order-independent (plain `.ts`).
   *
   * Requires `@babel/core` (an optional peer) as a devDependency of the app.
   * The locator's source-loc paths are relative to the same root injected as
   * `window.__AIUI__.sourceRoot` (this option's `sourceRoot`, else the Vite root).
   */
  locator?: boolean | { cellFactories?: string[]; factories?: FactorySpec[]; stampJsx?: boolean };
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
      if (id === MOUNT_ID) return MOUNT_ID;
      if (id === DEBUG_MOUNT_ID) return DEBUG_MOUNT_ID;
      return undefined;
    },
    // Serve the trace debugger at DEBUG_ROUTE (dev only, always). The page is a
    // thin shell: it seeds the channel port, pulls in Vite's HMR client, and
    // boots via its virtual mount module. It deliberately does NOT go through
    // transformIndexHtml (that path injects the turn-hosting intent tool —
    // wrong for a debugger view).
    configureServer(server) {
      const shell = (title: string, mountId: string): string => {
        const port = resolvePort();
        const seed = port === undefined ? "" : ` window.__AIUI__.port = ${port};`;
        return [
          "<!doctype html>",
          '<html lang="en"><head>',
          '<meta charset="utf-8" />',
          '<meta name="viewport" content="width=device-width, initial-scale=1" />',
          `<title>${title}</title>`,
          `<script>window.__AIUI__ ??= { v: 1, frames: [] };${seed}</script>`,
          '<script type="module" src="/@vite/client"></script>',
          `<script type="module" src="/@id/${mountId}"></script>`,
          "</head><body></body></html>",
        ].join("\n");
      };
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? "").split("?")[0];
        const html =
          path === DEBUG_ROUTE ? shell("aiui · lowering traces", DEBUG_MOUNT_ID) : undefined;
        if (html === undefined) {
          next();
          return;
        }
        res.statusCode = 200;
        res.setHeader("content-type", "text/html");
        res.end(html);
      });
    },
    load(id) {
      if (id === DEBUG_MOUNT_ID) {
        const port = resolvePort();
        return [
          `import { mountDebugPage } from ${JSON.stringify(`${PKG}/debug-ui`)};`,
          `mountDebugPage(${port === undefined ? "{}" : `{ port: ${port} }`});`,
          "",
        ].join("\n");
      }
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
        ...(options.actor === undefined ? [] : [`actor: ${scriptString(options.actor)}`]),
        // The 🔍 opens the trace debugger this plugin serves (the shared
        // debug-ui viewer), not the channel's built-in /debug fallback.
        `debugUrl: ${scriptString(DEBUG_ROUTE)}`,
        // `<` escaped so a config value can never close the module's <script>.
        ...(options.intent === undefined
          ? []
          : [`intent: ${JSON.stringify(options.intent).replace(/</g, "\\u003c")}`]),
      ];
      // A contributor view joins the bus but must not host a turn.
      const mountIntent = options.intentTool ?? true;
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
      // The session bus (unless disabled): installs at module eval like the
      // tools bridge, so peer views / app toolkits find
      // `window.__AIUI__.session` synchronously. `role` defaults to "app".
      const sessionArgs =
        options.session === false
          ? undefined
          : [
              ...(port === undefined ? [] : [`port: ${port}`]),
              `role: ${scriptString(options.session?.role ?? "app")}`,
              ...(options.session && options.session.label !== undefined
                ? [`label: ${scriptString(options.session.label)}`]
                : []),
            ].join(", ");
      // Import only what this view actually installs (kept alphabetical).
      const imports = [
        ...(mountIntent ? ["installPaintHost"] : []),
        ...(sessionArgs === undefined ? [] : ["installSessionBus"]),
        "installToolsBridge",
        ...(mountIntent ? ["mountIntentTool"] : []),
      ];
      return [
        `import { ${imports.join(", ")} } from ${JSON.stringify(PKG)};`,
        `installToolsBridge(${port === undefined ? "" : `{ port: ${port} }`});`,
        ...(sessionArgs === undefined ? [] : [`installSessionBus({ ${sessionArgs} });`]),
        // The paint host (turn-hosting views only): a no-op unless the channel
        // runs the paint sidecar; the iPad's ink lands in this intent tool.
        ...(mountIntent
          ? [`installPaintHost(${port === undefined ? "{}" : `{ port: ${port} }`});`]
          : []),
        // A contributor view stops here: bus + bridge, no turn host.
        ...(mountIntent
          ? [
              `const mount = () => ${mountCall};`,
              "const keep = () => {",
              "  mount();",
              "  new MutationObserver(mount).observe(document.body, { childList: true });",
              "};",
              'if (document.readyState === "complete") keep();',
              'else window.addEventListener("load", keep, { once: true });',
            ]
          : []),
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
  return [sourceLocatorVite({ root: options.sourceRoot, ...locatorOptions }), overlay];
}

export default aiuiDevOverlay;
