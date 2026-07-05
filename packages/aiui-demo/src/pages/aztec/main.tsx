/**
 * main.tsx — the aztec page entry: durable roots, then the graph, then the UI.
 *
 * Almost nothing here, by design. The durable canvas/worker/player/ring live in
 * store.ts; the dataflow and the agent tools (window.__aztec) live in graph.ts
 * (imported for side effect); the components are hot-swapped by solid-refresh
 * around the still-grown tiling. Shares src/lib and src/styles.css with
 * morphogen; a full page load per notebook is the resource policy (PRINCIPLES
 * §8, Level 1).
 */
import { render } from "@solidjs/web";
import "../../styles.css";
import "./page.css";
import "./graph"; // builds the cell graph + registers agent tools
import { App } from "./ui/App";

render(() => <App />, document.getElementById("root") as HTMLElement);
