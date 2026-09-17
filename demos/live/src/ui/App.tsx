/**
 * App.tsx — page 3: the aiui app, by voice. The oscillator above, the live
 * bench below, and the bridge between them is one line: the control
 * surface projected into typed tools (`toolsFromControlSurface`, reused from
 * the oracle as-is) and handed to whichever backend is chosen. Claude Code
 * gets them too — over the relay — and its working directory is this demo,
 * so "why is it jagged" ends in graph.ts.
 */

import type { LiveSession, LiveTool } from "@habemus-papadum/aiui-live";
import { onControlSurfaceChange, toolsFromControlSurface } from "@habemus-papadum/aiui-oracle";
import { createEffect, createSignal, onCleanup, untrack } from "solid-js";
import { Bench } from "../live/Bench";
import { LIVE_SLOTS } from "../live/prompt";
import { appScope } from "../model/store";
import { Nav } from "./Nav";
import { Oscilloscope } from "./Oscilloscope";

export function App() {
  const project = () => toolsFromControlSurface({ scope: appScope }) as LiveTool[];
  const [tools, setTools] = createSignal<LiveTool[]>(untrack(project));
  onCleanup(onControlSurfaceChange(() => setTools(untrack(project))));
  const [session, setSession] = createSignal<LiveSession | undefined>(undefined);
  // The surface is LIVE: a re-projection reaches the current session's tools
  // (and, in hosted mode, the next session's registration).
  createEffect(
    () => ({ s: session(), t: tools() }),
    ({ s, t }) => s?.setTools(t),
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
        options={{ slots: LIVE_SLOTS, app: "a damped-oscillator visualizer", tools }}
        initial="responses-browser"
        onSession={setSession}
      />
      <p class="app-foot">
        tools currently projected:{" "}
        {tools()
          .map((tool) => tool.name)
          .join(", ")}
      </p>
    </div>
  );
}
