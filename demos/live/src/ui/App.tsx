/**
 * App.tsx — page 3: the aiui app, by voice. The oscillator above, the live
 * bench below, and the bridge between them is one line: the control
 * surface projected into typed tools (`toolsFromControlSurface`, reused from
 * the oracle as-is) and handed to whichever backend is chosen. Claude Code
 * gets them too — over the relay — and its working directory is this demo,
 * so "why is it jagged" ends in graph.ts.
 */

import type { LiveSession, LiveTool } from "@habemus-papadum/aiui-live";
import { briefFromAiuiRegistry, toolsFromAiuiRegistry } from "@habemus-papadum/aiui-oracle";
import { ensureAiuiGlobal } from "@habemus-papadum/aiui-viz";
import { createEffect, createSignal, onCleanup, untrack } from "solid-js";
import { Bench } from "../live/Bench";
import { LIVE_SLOTS } from "../live/prompt";
import { appScope } from "../model/store";
import { Nav } from "./Nav";
import { Oscilloscope } from "./Oscilloscope";

export function App() {
  // The app's PAGE TOOLS — the kit's whole surface (report/set/locate, the
  // actions, anything registerTool added), with each tool's usage and the
  // kit's brief — exactly what the intent panel's oracle and Claude Code see.
  const namespaces = [appScope.name];
  const project = () => ({
    tools: (toolsFromAiuiRegistry({ namespaces }) ?? []) as LiveTool[],
    brief: briefFromAiuiRegistry({ namespaces }),
  });
  const [surface, setSurface] = createSignal(untrack(project));
  onCleanup(ensureAiuiGlobal()?.tools?.onChange(() => setSurface(untrack(project))) ?? (() => {}));
  const [session, setSession] = createSignal<LiveSession | undefined>(undefined);
  // The surface is LIVE: a re-projection reaches the current session's tools
  // (and, in hosted mode, the next session's registration).
  createEffect(
    () => ({ s: session(), surface: surface() }),
    ({ s, surface }) => s?.setTools(surface.tools, { brief: surface.brief }),
  );

  return (
    <div class="app">
      <Nav current="app" />
      <header class="app-head">
        <h1>the oscillator, by voice</h1>
        <p class="app-sub">
          Say "set the frequency to four", "kick it", "what is the damping" — the backend calls the
          app's typed tools. Then drop the samples to 24, raise the frequency, and ask "why does the
          trace look jagged?" with Claude Code as the backend: it reads{" "}
          <code>src/model/graph.ts</code> and tells you, and it can fix it by raising the samples.
        </p>
      </header>
      <Oscilloscope />
      <Bench
        options={{
          slots: LIVE_SLOTS,
          app: "a damped-oscillator visualizer",
          // The initial surface; the effect above keeps the session's tools
          // and brief current from then on.
          tools: () => surface().tools,
        }}
        initial="responses-browser"
        onSession={setSession}
      />
      <p class="app-foot">
        tools currently projected:{" "}
        {surface()
          .tools.map((tool) => tool.name)
          .join(", ")}
      </p>
    </div>
  );
}
