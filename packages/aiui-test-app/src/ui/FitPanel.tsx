/**
 * FitPanel.tsx — what EM currently believes, one row per component.
 *
 * The `fit` cell streams from the worker once per iteration, so the numbers
 * walk toward the answer live. The backend badge reports which engine
 * ACTUALLY computed the step — asking for webgpu on a machine without an
 * adapter honestly shows `js`.
 */
import { CellView } from "@habemus-papadum/aiui-viz";
import { For, Show } from "solid-js";
import { EM_ITERATIONS, graph } from "../model/graph";
import { ellipseFromGaussian } from "../model/mixture2d";
import { ellipses } from "../model/store";

const num = (v: number, digits = 1) => v.toFixed(digits);

export function FitPanel() {
  return (
    <section class="panel">
      <h2>EM fit</h2>
      <Show
        when={ellipses.get().length > 0}
        fallback={<p class="muted">draw at least one component to start fitting</p>}
      >
        <CellView of={graph().fit} label="fitting">
          {(step) => (
            <>
              <p class="muted">
                iteration {step().iter} / {EM_ITERATIONS} &nbsp;·&nbsp;{" "}
                <span class="badge">{step().backend}</span> &nbsp;·&nbsp; log-likelihood{" "}
                <b>{num(step().logLik)}</b>
              </p>
              <table class="kv">
                <thead>
                  <tr>
                    <th />
                    <th>weight</th>
                    <th>centre</th>
                    <th>2σ axes</th>
                    <th>tilt</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={step().params.components}>
                    {(g, j) => {
                      const e = () => ellipseFromGaussian(g);
                      return (
                        <tr>
                          <th>{j() + 1}</th>
                          <td>{step().params.weights[j()].toFixed(3)}</td>
                          <td>
                            {num(g.mx, 0)}, {num(g.my, 0)}
                          </td>
                          <td>
                            {num(e().a, 0)} × {num(e().b, 0)}
                          </td>
                          <td>{num((e().angle * 180) / Math.PI, 0)}°</td>
                        </tr>
                      );
                    }}
                  </For>
                </tbody>
              </table>
              <p class="note muted">
                EM does not know which drawn ellipse is which — components may come back permuted.
                Drawn components carry equal weights; recovered weights should approach 1/k.
              </p>
            </>
          )}
        </CellView>
      </Show>
    </section>
  );
}
