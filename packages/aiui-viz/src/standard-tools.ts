/**
 * standard-tools.ts — the two agent tools every aiui app should have, and which
 * no app should have to write.
 *
 * `locate` maps a CSS selector to the source locations behind it, and the
 * `cells` report section is the attribution table: every live named cell, its
 * state, and where it was defined. Both are app-independent — they read the
 * compile-time `data-source-loc` / `data-cell` stamps and the cell registry,
 * neither of which knows anything about a particular app — yet both were
 * copy-pasted into every app's `graph.ts` alongside the app's real tools.
 *
 * Kept in its own module (rather than folded into `agentToolkit`) for two
 * reasons: agent-tools.ts is deliberately dependency-free, and it would import
 * solid-js transitively via the cell registry; and an app that wants a bare tool
 * surface should be able to have one. It is therefore one explicit line:
 *
 * ```ts
 * const kit = agentToolkit("app");
 * registerStandardTools(kit);
 * ```
 */

import type { AgentToolkit } from "./agent-tools";
import { cellRegistry } from "./cell";

/** How many elements `locate` will describe in one call. */
const LOCATE_LIMIT = 20;

/**
 * Register the app-independent tools on a toolkit: the `locate` tool and the
 * `cells` report section. Idempotent by name, like every other registration —
 * safe to call from a module that re-evaluates under HMR.
 */
export function registerStandardTools(kit: AgentToolkit): void {
  kit.registerTool({
    name: "locate",
    description:
      "Map DOM elements to their source locations (compile-time data-source-loc stamps). " +
      "Combine with window.__AIUI__.sourceRoot for absolute paths.",
    params: { selector: `CSS selector; first ${LOCATE_LIMIT} matches returned` },
    run: (args) => {
      const selector = String(args?.selector ?? "*");
      return [...document.querySelectorAll(selector)].slice(0, LOCATE_LIMIT).map((el) => ({
        tag: el.tagName.toLowerCase(),
        text: (el.textContent ?? "").trim().slice(0, 40),
        source: el.closest("[data-source-loc]")?.getAttribute("data-source-loc") ?? null,
        cell: el.closest("[data-cell]")?.getAttribute("data-cell") ?? null,
      }));
    },
  });

  // The attribution table: every live named cell, its state, and where it is
  // defined — names match the data-cell stamps in the DOM.
  kit.registerReporter("cells", () => cellRegistry());
}
