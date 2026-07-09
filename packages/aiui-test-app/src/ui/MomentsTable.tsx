/**
 * MomentsTable.tsx — what the data says, ignorant of the model.
 *
 * Skewness is the interesting one: a single Gaussian has none, so a value far
 * from zero is the mixture announcing itself. Drag the two means together and
 * watch it collapse.
 */
import { CellView } from "@habemus-papadum/aiui-viz";
import { Show } from "solid-js";
import { appGraph } from "../model/graph";

const num = (v: number, digits = 3) => v.toFixed(digits);

export function MomentsTable() {
  return (
    <section class="panel">
      <h2>sample moments</h2>
      <Show when={appGraph()} fallback={<p class="muted">building dataflow graph…</p>}>
        {(graph) => (
          <CellView of={graph().moments} label="measuring">
            {(m) => (
              <table class="kv">
                <tbody>
                  <tr>
                    <th>n</th>
                    <td>{m().n.toLocaleString()}</td>
                  </tr>
                  <tr>
                    <th>mean</th>
                    <td>{num(m().mean)}</td>
                  </tr>
                  <tr>
                    <th>sd</th>
                    <td>{num(m().sd)}</td>
                  </tr>
                  <tr>
                    <th>skewness</th>
                    <td>{num(m().skewness)}</td>
                  </tr>
                  <tr>
                    <th>range</th>
                    <td>
                      {num(m().min, 2)} … {num(m().max, 2)}
                    </td>
                  </tr>
                </tbody>
              </table>
            )}
          </CellView>
        )}
      </Show>
    </section>
  );
}
