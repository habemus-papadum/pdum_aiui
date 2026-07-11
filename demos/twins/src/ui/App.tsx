/**
 * App.tsx — the root layout (playbook layer 4: the application shell).
 *
 * Components live in this directory (playbook layer 3) and are freely
 * hot-swappable, so build the page out of them. Keep them pure readers of the
 * durable signals (store.ts) and the cell graph (graph.ts): read a cell's
 * value by rendering it through `<CellView of={graph().someCell}>`, never by
 * importing a cell directly.
 */

import { graph } from "../model/graph";
import { left, right } from "../model/store";
import { Lissajous } from "./Lissajous";
import { Oscilloscope } from "./Oscilloscope";

export function App() {
  return (
    <div class="app">
      <header class="app-head">
        <h1>twins · one slice, two instances</h1>
        <p class="app-sub">
          Both oscillators are the SAME library slice (<code>@habemus-papadum/aiui-oscillator</code>
          ), instantiated under two scopes — distinct controls, distinct durable state, distinct
          agent tools (<code>left/kick</code>, <code>right/kick</code>) — then composed into one
          figure by a cell that reads across them. Open the console and call{" "}
          <code>__app.call("report")</code> to see the qualified surface.
        </p>
      </header>
      <main class="panels">
        <Oscilloscope
          title="left"
          accent="var(--left-accent)"
          store={left}
          trace={graph().leftTrace}
        />
        <Oscilloscope
          title="right"
          accent="var(--right-accent)"
          store={right}
          trace={graph().rightTrace}
        />
        <Lissajous figure={graph().lissajous} />
      </main>
    </div>
  );
}
