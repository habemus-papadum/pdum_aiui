/**
 * main.tsx — the app page's entry. Two processes make the loop:
 *
 *   terminal 1:  pnpm claude    Claude Code with the aiui channel + browser
 *   terminal 2:  pnpm dev       this app; the live backend rides the dev server
 *
 * The other two pages are /wire.html and /backends.html (see the nav).
 */

import { PageBoundary } from "@habemus-papadum/aiui-viz";
import { render } from "@solidjs/web";
import "./styles.css";
import "./model/graph"; // builds the cell graph + registers the agent tools
import { App } from "./ui/App";

document.title = "live · the oscillator, by voice";
render(
  () => (
    <PageBoundary name="live">
      <App />
    </PageBoundary>
  ),
  document.getElementById("root") as HTMLElement,
);
