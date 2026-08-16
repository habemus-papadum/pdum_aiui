/**
 * DiePanel.tsx — §1: the two prediction games scored live on a loaded die.
 *
 * Left: the die's true distribution (bars) with the empirical frequencies of
 * the simulated run (dots) on top. Right: the two running scores against their
 * floors — calling the next face can never beat 1 − max(p); stating the
 * distribution can never beat the entropy H(p), and sits on it immediately.
 */
import { chart, plot as plotInk, plotStyle } from "@habemus-papadum/aiui-journal";
import { CellView, ControlSlider } from "@habemus-papadum/aiui-viz";
import { PlotFigure } from "@habemus-papadum/aiui-viz/plot";
import * as Plot from "@observablehq/plot";
import { graph } from "../model/graph";
import { dieRolls, loadedness } from "../model/store";

const FACE_LABELS = ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];

export function DiePanel() {
  return (
    <div class="panel">
      <div class="panel-head">
        <h2>the loaded die, scored live</h2>
        <span class="legend">
          <i style={{ background: chart().blue }} /> true p
          <i style={{ background: chart().green }} /> observed
        </span>
      </div>

      <CellView of={graph().die} label="die">
        {(d) => {
          const distOptions = (): Plot.PlotOptions => {
            const v = d();
            const n = v.run.rolls.length;
            const rows = v.p.map((p, i) => ({
              face: FACE_LABELS[i],
              p,
              observed: v.run.counts[i] / n,
            }));
            return {
              height: 200,
              style: plotStyle(),
              x: { label: null },
              y: { label: "probability", grid: true },
              marks: [
                Plot.barY(rows, { x: "face", y: "p", fill: chart().blue, fillOpacity: 0.55 }),
                Plot.dot(rows, { x: "face", y: "observed", fill: chart().green, r: 5 }),
                Plot.ruleY([0]),
              ],
            };
          };

          const pointwiseOptions = (): Plot.PlotOptions => {
            const v = d();
            const rows = v.run.pointwiseErr.map((e, i) => ({ roll: i + 1, err: e }));
            return {
              height: 200,
              style: plotStyle(),
              x: { label: "rolls", type: "log" },
              y: { label: "error rate", domain: [0, 1], grid: true },
              marks: [
                Plot.lineY(rows, { x: "roll", y: "err", stroke: chart().blue, strokeWidth: 2 }),
                Plot.ruleY([v.pointwiseFloor], {
                  stroke: plotInk().strong,
                  strokeDasharray: "4 4",
                }),
                Plot.text([{ x: rows.length, y: v.pointwiseFloor }], {
                  x: "x",
                  y: "y",
                  text: () => `floor 1−max p = ${v.pointwiseFloor.toFixed(2)}`,
                  dy: -8,
                  textAnchor: "end",
                  fill: plotInk().strong,
                }),
              ],
            };
          };

          const distributionalOptions = (): Plot.PlotOptions => {
            const v = d();
            const rows = v.run.logLoss.map((l, i) => ({ roll: i + 1, bits: l }));
            const top = Math.max(Math.log2(6) * 1.15, v.run.logLoss[0] ?? 0);
            return {
              height: 200,
              style: plotStyle(),
              x: { label: "rolls", type: "log" },
              y: { label: "log loss (bits)", domain: [0, top], grid: true },
              marks: [
                Plot.lineY(rows, { x: "roll", y: "bits", stroke: chart().purple, strokeWidth: 2 }),
                Plot.ruleY([v.entropy], { stroke: plotInk().strong, strokeDasharray: "4 4" }),
                Plot.text([{ x: rows.length, y: v.entropy }], {
                  x: "x",
                  y: "y",
                  text: () => `floor H(p) = ${v.entropy.toFixed(2)} bits`,
                  dy: -8,
                  textAnchor: "end",
                  fill: plotInk().strong,
                }),
              ],
            };
          };

          return (
            <>
              <div class="regimes-plot-row">
                <div>
                  <div class="panel-sub">the die</div>
                  <PlotFigure options={distOptions} />
                </div>
                <div>
                  <div class="panel-sub">game 1 · call the next face</div>
                  <PlotFigure options={pointwiseOptions} />
                </div>
                <div>
                  <div class="panel-sub">game 2 · state the distribution</div>
                  <PlotFigure options={distributionalOptions} />
                </div>
              </div>

              <div class="tiles">
                <div class="tile">
                  <div class="tile-value">{(1 - d().pointwiseFloor).toFixed(2)}</div>
                  <div class="tile-label">best hit rate (game 1)</div>
                </div>
                <div class="tile">
                  <div class="tile-value">{d().entropy.toFixed(2)} bits</div>
                  <div class="tile-label">entropy floor (game 2)</div>
                </div>
                <div class="tile">
                  <div class="tile-value">{d().run.logLoss.at(-1)?.toFixed(2)}</div>
                  <div class="tile-label">achieved log loss</div>
                </div>
              </div>
            </>
          );
        }}
      </CellView>

      <div class="controls-grid">
        <ControlSlider of={loadedness} label="loadedness" format={(v) => v.toFixed(2)} />
        <ControlSlider of={dieRolls} label="rolls" format={(v) => `${v}`} />
      </div>
    </div>
  );
}
