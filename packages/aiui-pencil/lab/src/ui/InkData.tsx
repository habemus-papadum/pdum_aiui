/** Reactive statistics over completed and live ink records. */

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
                  {stats().erased > 0 ? ` (${stats().erased} partly erased)` : ""}
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
        Each stroke retains its samples and numerical profile. Live input updates while drawing;
        undo, redo, and erasure update the same document. Enclosed area uses the newest stroke's
        source path, before erasure masks are applied.
      </p>
    </section>
  );
}
