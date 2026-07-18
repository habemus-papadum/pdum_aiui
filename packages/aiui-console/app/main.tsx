/**
 * The console app's entry: a two-route SPA on one origin (the channel).
 *
 *  - `/__aiui/debug` → the trace debugger, reusing `aiui-trace-ui`'s page
 *    pointed at THIS channel (it mounts itself into the document).
 *  - anything else   → the dashboard.
 *
 * Routing is a single path check, not a router library: there are two routes,
 * both server-served via the SPA fallback, and the choice never changes after
 * load.
 */

import { mountDebugPage } from "@habemus-papadum/aiui-trace-ui";
import { render } from "@solidjs/web";
import { Dashboard } from "./dashboard";
import { CONSOLE_DEBUG_PATH } from "./routes";

const here = location.pathname.replace(/\/+$/, "");

if (here === CONSOLE_DEBUG_PATH.replace(/\/+$/, "")) {
  // Same-origin: the page is served from the channel itself, so its own port
  // is all the debugger needs to poll this channel.
  mountDebugPage({ port: Number(location.port) || undefined });
} else {
  const root = document.getElementById("root");
  if (root !== null) {
    render(() => <Dashboard />, root);
  }
}
