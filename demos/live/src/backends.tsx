/**
 * backends.tsx — page 2: the BACKENDS, without aiui. Three toy tools (a
 * clock, an adder, a slow lookup) and every backend the package knows:
 * scripted, echo, a Responses model in the browser or on the server,
 * Claude Code on the server, and the vendor-hosted Responses mode. Ask the
 * same things of each — "what time is it", "add 17 and 25", "look up the
 * Dirichlet kernel, take twenty seconds" — and compare the task timings and
 * what gets narrated while the slow one runs.
 */

import { PageBoundary } from "@habemus-papadum/aiui-viz";
import { render } from "@solidjs/web";
import "./styles.css";
import { Bench } from "./live/Bench";
import { BACKENDS_SLOTS } from "./live/prompt";
import { benchTools } from "./live/tools";
import { Nav } from "./ui/Nav";

function BackendsPage() {
  return (
    <div class="app">
      <Nav current="backends" />
      <header class="app-head">
        <h1>backends · who does the thinking</h1>
        <p class="app-sub">
          The voice model never calls a tool. It hands each request to a backend as a delegation and
          keeps talking. Here the backends have three tools — <code>clock</code>, <code>add</code>,{" "}
          <code>slow_lookup</code> — and you choose who runs them. Try the slow lookup with "take
          thirty seconds" and ask something else while it runs: two open tickets, both answered.
          Then switch to Claude Code and ask "what tools do you have, and which is slowest?".
        </p>
      </header>
      <Bench
        options={{ slots: BACKENDS_SLOTS, app: "a bench with three toy tools", tools: benchTools }}
        initial="responses-browser"
      />
    </div>
  );
}

render(
  () => (
    <PageBoundary name="backends">
      <BackendsPage />
    </PageBoundary>
  ),
  document.getElementById("root") as HTMLElement,
);
