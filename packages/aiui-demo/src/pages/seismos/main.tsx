/**
 * main.tsx — the seismos page entry: durable roots, then the graph, then the UI.
 *
 * Almost nothing here, by design. The DuckDB stack, the Mosaic coordinator, the
 * crossfilter selection, and the controls live in store.ts; the dataflow and the
 * agent tools (window.__seismos) live in graph.ts (imported for side effect);
 * the components are hot-swapped by solid-refresh around the still-loaded table.
 * Shares src/styles.css with morphogen/aztec; a full page load per notebook is
 * the resource policy (design-choices §8, Level 1).
 */
import { render } from "@solidjs/web";
import "../../styles.css";
import "./page.css";
import "./graph"; // builds the cell graph + registers agent tools
import { App } from "./ui/App";

render(() => <App />, document.getElementById("root") as HTMLElement);
