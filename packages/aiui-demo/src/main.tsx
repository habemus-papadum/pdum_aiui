/**
 * main.tsx — the entry: durable roots first, then the graph, then the UI.
 *
 * There is deliberately almost nothing here. The aiui intent tool is mounted
 * by the aiuiDevOverlay() Vite plugin (vite.config.ts), the sim/loop/worker
 * live in the durable registry (model/store.ts), and the dataflow lives in
 * the graph module (model/graph.ts) — each with its own HMR story:
 *
 *   - ui/ components: hot-swapped by solid-refresh, durable canvas adopted.
 *   - model/graph.ts: self-swaps the cell graph over the durable roots.
 *   - sim/shaders.ts: accepted HERE — the engine recompiles its programs in
 *     place, so a GLSL edit updates the running field without resetting it.
 *     (An edit is just another cause of invalidation; the field is the state
 *     it must not invalidate.)
 */

import { render } from "@solidjs/web";
import "./styles.css";
import { initSystemTheme } from "./site/theme";

initSystemTheme(); // morphogen follows prefers-color-scheme (style-guide default)

import "./model/graph"; // builds the cell graph + registers agent tools
import { App } from "./ui/App";

// Source location stamps: babel-source-locator.mjs (vite.config.ts) tags every
// host JSX element with data-source-loc="src/…:line:col" — read it off the DOM
// or call window.__morpho.call("locate", { selector }). It replaced LocatorJS
// after the trial recorded in PRINCIPLES.md §7 (its babel half worked on Solid
// 2.0 but gave file-level-only ids; its runtime UI is compiled against 1.x).

render(() => <App />, document.getElementById("root") as HTMLElement);
