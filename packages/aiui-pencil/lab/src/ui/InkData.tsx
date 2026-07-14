/**
 * InkData.tsx — the drawing, as numbers: the worked example of the reactive
 * surface (phase 4b).
 *
 * This panel is deliberately a *pure consumer*: it knows nothing about canvases
 * or pens, it reads one cell, and that cell computes over `ink.strokes()` and
 * `ink.live()` like any other data. If you can build this panel, you can build
 * the "compute the area of what the user circled" feature — which is the point.
 * Watch the live row while you draw: it moves mid-stroke, at ~15 Hz, and its
 * final value never misses a point (snapshots are cumulative; the throttle can
 * only drop emissions, never data).
 */

import { CellView } from "@habemus-papadum/aiui-viz";
import type { JSX } from "@solidjs/web";
import { graph } from "../model/graph";

const px2 = (v: number): string =>
  v >= 10000 ? `${(v / 1000).toFixed(1)}k px²` : `${Math.round(v)} px²`;

export function InkData(): JSX.Element {
  return (
    <section class="panel" id="ink-data">
      <h2>The drawing, as data</h2>
      <CellView of={graph().inkStats} label="ink stats">
        {(stats) => (
          <table class="telemetry" data-cell="inkStats">
            <tbody>
              <tr>
                <th>strokes</th>
                <td>
                  {stats().strokeCount}
                  {stats().erased > 0 ? ` (${stats().erased} eraser)` : ""}
                </td>
              </tr>
              <tr>
                <th>points</th>
                <td>{stats().totalPoints}</td>
              </tr>
              <tr class={stats().livePoints > 0 ? "live-row" : undefined}>
                <th>live stroke</th>
                <td>
                  {stats().livePoints > 0
                    ? `${stats().livePoints} pts · ${Math.round(stats().liveLengthPx)} px`
                    : "—"}
                </td>
              </tr>
              <tr>
                <th>encloses</th>
                <td>{stats().enclosedPx2 > 0 ? px2(stats().enclosedPx2) : "—"}</td>
              </tr>
            </tbody>
          </table>
        )}
      </CellView>
      <p class="hint">
        Computed from <code>ink.strokes()</code> / <code>ink.live()</code> — the surface's own
        record, as signals. The area re-runs the widget's pipeline (<code>planStroke</code> with the
        live knobs) on the newest stroke; substitute your own parameters to disagree with it.
      </p>
    </section>
  );
}
