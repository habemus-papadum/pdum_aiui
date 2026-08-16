/**
 * EnsemblePanel.tsx — §4: what averaging M refits does to the loss.
 *
 * The curve is test MSE vs ensemble size M. The dashed line is what averaging
 * can never remove — the floor plus the approximation term: only estimation
 * shrinks (like 1/M for independent errors). Flip the family knob into the
 * approximation-limited regime and watch the curve go flat: averaging cannot
 * express what no member can. The disagreement tile is the truth-free
 * diagnostic — variance across members, computable without knowing f.
 */
import { chart, plot as plotInk, plotStyle } from "@habemus-papadum/aiui-journal";
import { CellView, ControlSlider, ControlToggle } from "@habemus-papadum/aiui-viz";
import { PlotFigure } from "@habemus-papadum/aiui-viz/plot";
import * as Plot from "@observablehq/plot";
import { graph } from "../model/graph";
import { degree, heterogeneous, members, samples } from "../model/store";

export function EnsemblePanel() {
  return (
    <div class="panel">
      <div class="panel-head">
        <h2>averaging the committee</h2>
        <span class="legend">
          <i style={{ background: chart().blue }} /> test MSE of the M-average
        </span>
      </div>

      <CellView of={graph().decomp} label="decomposition">
        {(dd) => (
          <CellView of={graph().ens} label="ensemble">
            {(ee) => {
              const options = (): Plot.PlotOptions => {
                const e = ee();
                const d = dd();
                const rows = e.mseByM.map((mse, i) => ({ M: i + 1, mse }));
                const irreducible = d.floor + d.approximation;
                return {
                  height: 260,
                  style: plotStyle(),
                  x: { label: "ensemble size M", ticks: Math.min(12, e.mseByM.length) },
                  y: {
                    label: "test MSE",
                    type: "log",
                    grid: true,
                    tickFormat: (d: number) => (d >= 1 ? String(d) : d.toPrecision(1)),
                  },
                  marks: [
                    Plot.lineY(rows, { x: "M", y: "mse", stroke: chart().blue, strokeWidth: 2 }),
                    Plot.dot(rows, { x: "M", y: "mse", fill: chart().blue, r: 3 }),
                    Plot.ruleY([irreducible], {
                      stroke: plotInk().strong,
                      strokeDasharray: "4 4",
                    }),
                    Plot.text([{ x: e.mseByM.length, y: irreducible }], {
                      x: "x",
                      y: "y",
                      text: () => "floor + approximation — averaging stops here",
                      dy: -8,
                      textAnchor: "end",
                      fill: plotInk().strong,
                    }),
                  ],
                };
              };

              return (
                <>
                  <PlotFigure options={options} />
                  <div class="tiles">
                    <div class="tile">
                      <div class="tile-value">{ee().mseByM[0].toFixed(3)}</div>
                      <div class="tile-label">one model (M = 1)</div>
                    </div>
                    <div class="tile">
                      <div class="tile-value">{ee().mseByM.at(-1)?.toFixed(3)}</div>
                      <div class="tile-label">the committee (M = {ee().mseByM.length})</div>
                    </div>
                    <div class="tile">
                      <div class="tile-value">{ee().disagreement.toFixed(3)}</div>
                      <div class="tile-label">disagreement (no truth needed)</div>
                    </div>
                  </div>
                </>
              );
            }}
          </CellView>
        )}
      </CellView>

      <div class="controls-grid">
        <ControlSlider of={members} label="ensemble size" format={(v) => `${v}`} />
        <ControlSlider of={degree} label="family · degree" format={(v) => `${v}`} />
        <ControlSlider of={samples} label="samples n" format={(v) => `${v}`} />
      </div>
      <div class="controls-buttons">
        <ControlToggle of={heterogeneous} label="heterogeneous members (degrees d−2 … d+2)" />
      </div>
    </div>
  );
}
