/**
 * Picture.tsx — the picture, rendered through CellView so it wears the
 * notebook chrome (pending spinner, error+retry, keep-latest while
 * recomputing) the moment the compute behind it stops being instant. The
 * data-cell stamp CellView adds is what lets "this drawing" resolve to the
 * `rose` cell in graph.ts.
 */
import { CellView } from "@habemus-papadum/aiui-viz";
import { Show } from "solid-js";
import { appGraph } from "../model/graph";
import { angleStep, petals } from "../model/store";

export function Picture() {
  return (
    <section class="picture panel">
      <Show when={appGraph()} fallback={<p class="muted">building dataflow graph…</p>}>
        {(graph) => (
          <CellView of={graph().rose} label="drawing">
            {(rose) => (
              <svg
                class="rose"
                viewBox="-1.08 -1.08 2.16 2.16"
                role="img"
                aria-label={`Maurer rose: ${petals.get()} petals, ${angleStep.get()}° step`}
              >
                <path class="rose-outline" d={rose().outline} />
                <path class="rose-walk" d={rose().walk} />
              </svg>
            )}
          </CellView>
        )}
      </Show>
      <p class="caption muted">
        a Maurer rose — 361 chords walked around r = sin({petals.get()}·θ) in {angleStep.get()}°
        hops
      </p>
    </section>
  );
}
