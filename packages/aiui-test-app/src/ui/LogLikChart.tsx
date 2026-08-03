/**
 * LogLikChart.tsx — the log-likelihood trace, drawn as the algorithm runs.
 *
 * EM's guarantee is that this curve never goes down. The worker streams the
 * accumulated `trace` once per iteration, so the line walks rightward across
 * a fixed 1..EM_ITERATIONS domain while the run streams — the monotone climb
 * is visible instead of inferred from a flickering number.
 */
import { CellView } from "@habemus-papadum/aiui-viz";
import { For, Show } from "solid-js";
import { EM_ITERATIONS, graph } from "../model/graph";
import { ellipses } from "../model/store";

const W = 680;
const H = 240;
const M = { top: 16, right: 16, bottom: 40, left: 84 };
const IW = W - M.left - M.right;
const IH = H - M.top - M.bottom;

/** Evenly spaced 1-based iteration ticks across the run. */
function iterTicks(count: number): number[] {
  return Array.from({ length: count + 1 }, (_, i) =>
    Math.round(1 + ((EM_ITERATIONS - 1) * i) / count),
  );
}

export function LogLikChart() {
  return (
    <Show when={ellipses.get().length > 0}>
      <section class="panel chart">
        <h2>log-likelihood</h2>
        <CellView of={graph().fit} label="fitting">
          {(step) => {
            const trace = () => step().trace;
            const lo = () => Math.min(...trace());
            const hi = () => Math.max(...trace());
            // Pad the y-range 5% each way; a flat (or 1-point) trace still
            // needs a nonzero span to map through.
            const span = () => (hi() - lo() || Math.max(Math.abs(hi()) * 1e-3, 1)) * 1.1;
            const yLo = () => lo() - span() / 22;
            const x = (iter: number) => M.left + ((iter - 1) / Math.max(EM_ITERATIONS - 1, 1)) * IW;
            const y = (v: number) => M.top + IH - ((v - yLo()) / span()) * IH;
            const path = () =>
              trace()
                .map((v, i) => `${i === 0 ? "M" : "L"}${x(i + 1)},${y(v)}`)
                .join(" ");

            return (
              <svg
                class="chart-svg"
                viewBox={`0 0 ${W} ${H}`}
                role="img"
                aria-label="Log-likelihood per EM iteration, updating as the algorithm runs"
              >
                <title>log-likelihood per iteration</title>

                <For each={[lo(), lo() + (hi() - lo()) / 2, hi()]}>
                  {(v) => (
                    <>
                      <line class="grid" x1={M.left} x2={W - M.right} y1={y(v)} y2={y(v)} />
                      <text class="tick" x={M.left - 8} y={y(v) + 4} text-anchor="end">
                        {v.toFixed(1)}
                      </text>
                    </>
                  )}
                </For>

                <line class="axis" x1={M.left} x2={W - M.right} y1={M.top + IH} y2={M.top + IH} />
                <For each={iterTicks(4)}>
                  {(iter) => (
                    <text class="tick" x={x(iter)} y={M.top + IH + 18} text-anchor="middle">
                      {iter}
                    </text>
                  )}
                </For>
                <text class="tick" x={M.left + IW / 2} y={H - 6} text-anchor="middle">
                  iteration
                </text>

                <path class="curve-loglik" d={path()} />
                <circle
                  class="loglik-dot"
                  cx={x(trace().length)}
                  cy={y(trace()[trace().length - 1])}
                  r={3.5}
                />
              </svg>
            );
          }}
        </CellView>
      </section>
    </Show>
  );
}
