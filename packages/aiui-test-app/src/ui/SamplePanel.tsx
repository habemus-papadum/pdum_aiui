/**
 * SamplePanel.tsx — the raw draw, at the head of the chain.
 *
 * The only widget bound to the `samples` cell itself, so it is where the
 * pending spinner and the progress stripe actually show: raise the sample count
 * and this panel is the one that visibly waits.
 */
import { CellView } from "@habemus-papadum/aiui-viz";
import { For, Show } from "solid-js";
import { appGraph } from "../model/graph";
import { seed } from "../model/store";

const PREVIEW = 8;

export function SamplePanel() {
  return (
    <section class="panel">
      <h2>sample</h2>
      <Show when={appGraph()} fallback={<p class="muted">building dataflow graph…</p>}>
        {(graph) => (
          <CellView of={graph().samples} label="drawing">
            {(data) => (
              <>
                <p class="muted">
                  {data().length.toLocaleString()} draws · seed <b>{seed.get()}</b>
                </p>
                <ul class="preview">
                  <For each={[...data().slice(0, PREVIEW)]}>{(x) => <li>{x.toFixed(3)}</li>}</For>
                  <li class="muted">…</li>
                </ul>
              </>
            )}
          </CellView>
        )}
      </Show>
    </section>
  );
}
