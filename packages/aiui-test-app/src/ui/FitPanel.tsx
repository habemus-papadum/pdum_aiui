/**
 * FitPanel.tsx — what EM currently believes, next to the truth it is chasing.
 *
 * The `fit` cell is an async iterable, so this panel updates once per EM
 * iteration rather than once per run. Watching `logLik` climb monotonically is
 * the cheapest correctness check the algorithm has.
 */
import { CellView } from "@habemus-papadum/aiui-viz";
import { Show } from "solid-js";
import { appGraph, EM_ITERATIONS } from "../model/graph";
import { mu1, mu2, sigma1, sigma2, weight } from "../model/store";

const num = (v: number, digits = 3) => v.toFixed(digits);

export function FitPanel() {
  return (
    <section class="panel">
      <h2>EM fit</h2>
      <Show when={appGraph()} fallback={<p class="muted">building dataflow graph…</p>}>
        {(graph) => (
          <CellView of={graph().fit} label="fitting">
            {(step) => (
              <>
                <p class="muted">
                  iteration {step().iter} / {EM_ITERATIONS} &nbsp;·&nbsp; log-likelihood{" "}
                  <b>{num(step().logLik, 1)}</b>
                </p>
                <table class="kv">
                  <thead>
                    <tr>
                      <th />
                      <th>estimate</th>
                      <th>truth</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <th>weight</th>
                      <td>{num(step().params.weight)}</td>
                      <td class="muted">{num(weight.get())}</td>
                    </tr>
                    <tr>
                      <th>μ₁</th>
                      <td>{num(step().params.mu1)}</td>
                      <td class="muted">{num(mu1.get())}</td>
                    </tr>
                    <tr>
                      <th>σ₁</th>
                      <td>{num(step().params.sigma1)}</td>
                      <td class="muted">{num(sigma1.get())}</td>
                    </tr>
                    <tr>
                      <th>μ₂</th>
                      <td>{num(step().params.mu2)}</td>
                      <td class="muted">{num(mu2.get())}</td>
                    </tr>
                    <tr>
                      <th>σ₂</th>
                      <td>{num(step().params.sigma2)}</td>
                      <td class="muted">{num(sigma2.get())}</td>
                    </tr>
                  </tbody>
                </table>
                <p class="note muted">
                  EM does not know which component is which — a swapped pair is the same fit.
                </p>
              </>
            )}
          </CellView>
        )}
      </Show>
    </section>
  );
}
