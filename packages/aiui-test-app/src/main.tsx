/**
 * main.tsx — the entry point, and deliberately almost empty.
 *
 * The aiui intent tool is mounted by the `aiuiDevOverlay()` Vite plugin (see
 * vite.config.ts — that plugin *is* the whole aiui integration). The app splits
 * along HMR lines:
 *
 *   src/model/store.ts    durable roots — slider positions survive hot edits
 *   src/model/mixture.ts  pure mathematics (no Solid, no aiui)
 *   src/model/graph.ts    the cell graph + the agent tools
 *   src/ui/               components — freely hot-swappable
 *
 * Run it against a channel that has no Claude session behind it:
 *
 *   terminal 1:  pnpm test-app:channel   (prints lowered prompts to stdout)
 *   terminal 2:  pnpm test-app
 */
import { render } from "@solidjs/web";
import "./styles.css";
import "./model/graph"; // builds the cell graph + registers agent tools
import { App } from "./ui/App";

render(() => <App />, document.getElementById("root") as HTMLElement);
