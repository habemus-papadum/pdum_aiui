/**
 * vite.ts — DEPRECATED (the 2026-07-14 plugin restructure): the aiui build
 * integration lives at `@habemus-papadum/aiui-source-processor` now, with two jobs —
 * the source-locator compiler pass and the dev-only `sourceRoot` seed — and
 * deliberately nothing else.
 *
 * Everything else this plugin used to inject is RETIRED, not relocated:
 *
 *  - **channel-port injection** (`window.__AIUI__.port`) — connectivity
 *    arrives from the intent client (the Chrome extension or the CDP tier);
 *    apps and their pages dial nothing.
 *  - **the page-side tools bridge** (`installToolsBridge`, the `/tools` ws) —
 *    pages populate the always-on `window.__AIUI__.tools` registry (the viz
 *    RUNTIME installs it, production included) and the intent client
 *    represents them to the channel (`aiui-intent-client/src/tools-link.ts`).
 *  - **the session bus** (`window.__AIUI__.session`) — its consumers were the
 *    demoted overlay modality and the being-re-envisioned paint host; it
 *    returns, redesigned, if that work wants it.
 *  - **overlay mounting / `/__aiui/debug` serving** — the intent client's
 *    panel embeds the trace debugger; `aiui debug` serves it standalone.
 *
 * This wrapper keeps the frozen `aiui-extension` build (and any straggler
 * config) compiling for one release: it runs the LOCATOR ONLY, via the moved
 * module, whatever other options it is handed.
 */

import { aiui } from "@habemus-papadum/aiui-source-processor";
import type { Plugin } from "vite";

// The moved pass's helpers, re-exported so old imports keep resolving.
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

/** The old option bag, accepted and mostly ignored (see the module doc). */
export interface AiuiDevOverlayOptions {
  locator?: boolean | { cellFactories?: string[]; factories?: unknown[]; [key: string]: unknown };
  [key: string]: unknown;
}

/** @deprecated Use `aiui()` from `@habemus-papadum/aiui-source-processor`. */
export function aiuiDevOverlay(options: AiuiDevOverlayOptions = {}): Plugin | Plugin[] {
  console.warn(
    "[aiui] aiuiDevOverlay() is deprecated — use aiui() from @habemus-papadum/aiui-source-processor " +
      "(the locator still runs; the overlay/port/tools/session injections are retired).",
  );
  return aiui({ locator: (options.locator as never) ?? true });
}

export default aiuiDevOverlay;
