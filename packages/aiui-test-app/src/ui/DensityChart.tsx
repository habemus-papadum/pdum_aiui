/**
 * DensityChart.tsx — the histogram, the true density, and the EM estimate, on
 * one pair of axes.
 *
 * Rendered through CellView, so it wears the notebook chrome (spinner, error +
 * retry, keep-the-last-render while recomputing) and carries the
 * `data-cell="curves"` stamp that lets "this chart" resolve back to the cell in
 * graph.ts. Because `fit` streams a value per EM iteration, `curves` recomputes
 * per iteration too — the dashed line walks onto the data.
 */
import { CellView } from "@habemus-papadum/aiui-viz";
import { For, Show } from "solid-js";
import { appGraph } from "../model/graph";

const W = 680;
const H = 340;
const M = { top: 16, right: 16, bottom: 34, left: 54 };
const IW = W - M.left - M.right;
const IH = H - M.top - M.bottom;

/** Evenly spaced tick values across [lo, hi]. */
function ticks(lo: number, hi: number, count: number): number[] {
  return Array.from({ length: count + 1 }, (_, i) => lo + ((hi - lo) * i) / count);
}

export function DensityChart() {
  return (
    <section class="panel chart">
      <h2>density</h2>
      <Show when={appGraph()} fallback={<p class="muted">building dataflow graph…</p>}>
        {(graph) => (
          <CellView of={graph().curves} label="plotting">
            {(curves) => {
              const x = (v: number) =>
                M.left + ((v - curves().lo) / (curves().hi - curves().lo)) * IW;
              const y = (v: number) => M.top + IH - (v / curves().yMax) * IH;
              const path = (pts: Array<{ x: number; y: number }>) =>
                pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.x)},${y(p.y)}`).join(" ");

              return (
                <svg
                  class="chart-svg"
                  viewBox={`0 0 ${W} ${H}`}
                  role="img"
                  aria-label="Histogram of the sample, with the true mixture density and the current EM estimate"
                >
                  <title>mixture density</title>

                  <For each={ticks(0, curves().yMax, 4)}>
                    {(v) => (
                      <>
                        <line class="grid" x1={M.left} x2={W - M.right} y1={y(v)} y2={y(v)} />
                        <text class="tick" x={M.left - 8} y={y(v) + 4} text-anchor="end">
                          {v.toFixed(2)}
                        </text>
                      </>
                    )}
                  </For>

                  <For each={curves().bars}>
                    {(b) => (
                      <rect
                        class="bar"
                        x={x(b.x - b.width / 2)}
                        y={y(b.y)}
                        width={Math.max(0, (b.width / (curves().hi - curves().lo)) * IW - 1)}
                        height={Math.max(0, M.top + IH - y(b.y))}
                      />
                    )}
                  </For>

                  <path class="curve-truth" d={path(curves().truth)} />
                  <path class="curve-fitted" d={path(curves().fitted)} />

                  <line class="axis" x1={M.left} x2={W - M.right} y1={M.top + IH} y2={M.top + IH} />
                  <For each={ticks(curves().lo, curves().hi, 6)}>
                    {(v) => (
                      <text class="tick" x={x(v)} y={M.top + IH + 20} text-anchor="middle">
                        {v.toFixed(1)}
                      </text>
                    )}
                  </For>
                </svg>
              );
            }}
          </CellView>
        )}
      </Show>
      <p class="legend muted">
        <span class="swatch swatch-bar" /> sample &nbsp;
        <span class="swatch swatch-truth" /> true density &nbsp;
        <span class="swatch swatch-fitted" /> EM estimate
      </p>
    </section>
  );
}
