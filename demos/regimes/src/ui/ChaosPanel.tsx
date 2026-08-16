/**
 * ChaosPanel.tsx — §6: the logistic map at r = 4. Pointwise prediction dies
 * exponentially (Lyapunov λ = ln 2: the error doubles every step), while the
 * trajectory's statistics converge to a closed-form invariant density and stay
 * learnable forever. One simulator, opposite fates for the two games of §1.
 */
import { chart, plot as plotInk, plotStyle } from "@habemus-papadum/aiui-journal";
import { CellView, ControlSlider } from "@habemus-papadum/aiui-viz";
import { PlotFigure } from "@habemus-papadum/aiui-viz/plot";
import * as Plot from "@observablehq/plot";
import { LYAPUNOV } from "../model/chaos";
import { graph } from "../model/graph";
import { perturbation } from "../model/store";

export function ChaosPanel() {
  return (
    <div class="panel">
      <div class="panel-head">
        <h2>x → 4x(1−x)</h2>
        <span class="legend">
          <i style={{ background: chart().blue }} /> trajectory
          <i style={{ background: chart().purple }} /> its ε-twin
        </span>
      </div>

      <CellView of={graph().chaos} label="chaos">
        {(cc) => {
          const pairOptions = (): Plot.PlotOptions => {
            const p = cc().pair;
            const rows = p.n.map((n, i) => ({ n, a: p.a[i], b: p.b[i] }));
            return {
              height: 240,
              style: plotStyle(),
              x: { label: "step n" },
              y: { label: "x", domain: [0, 1] },
              marks: [
                Plot.lineY(rows, { x: "n", y: "a", stroke: chart().blue, strokeWidth: 1.5 }),
                Plot.lineY(rows, { x: "n", y: "b", stroke: chart().purple, strokeWidth: 1.5 }),
              ],
            };
          };

          const divOptions = (): Plot.PlotOptions => {
            const d = cc().div;
            const rows = d.n
              .map((n, i) => ({ n, err: d.meanErr[i], pred: d.predicted[i] }))
              .filter((r) => r.err > 0);
            return {
              height: 240,
              style: plotStyle(),
              x: { label: "forecast horizon (steps)" },
              y: {
                label: "mean |error|",
                type: "log",
                grid: true,
                tickFormat: (d: number) => (d >= 0.01 ? String(d) : d.toExponential(0)),
              },
              marks: [
                Plot.lineY(rows, {
                  x: "n",
                  y: "pred",
                  stroke: plotInk().strong,
                  strokeDasharray: "4 4",
                }),
                Plot.lineY(rows, { x: "n", y: "err", stroke: chart().blue, strokeWidth: 2 }),
                Plot.ruleX([d.horizonSteps], { stroke: chart().purple, strokeDasharray: "3 3" }),
                Plot.text([{ x: d.horizonSteps, y: 0.3 }], {
                  x: "x",
                  y: "y",
                  text: () => `horizon ≈ ${d.horizonSteps} steps`,
                  dx: 6,
                  textAnchor: "start",
                  fill: chart().purple,
                }),
              ],
            };
          };

          const invOptions = (): Plot.PlotOptions => {
            const h = cc().inv;
            const rows = h.centers.map((x, i) => ({ x, density: h.density[i], law: h.arcsine[i] }));
            return {
              height: 240,
              style: plotStyle(),
              x: { label: "x" },
              y: { label: "density", grid: true, domain: [0, 4] },
              marks: [
                Plot.rectY(rows, {
                  x1: (r: { x: number }) => r.x - 1 / 96,
                  x2: (r: { x: number }) => r.x + 1 / 96,
                  y: "density",
                  fill: chart().blue,
                  fillOpacity: 0.4,
                  clip: true,
                }),
                Plot.lineY(rows, {
                  x: "x",
                  y: "law",
                  stroke: chart().green,
                  strokeWidth: 2,
                  clip: true,
                }),
              ],
            };
          };

          return (
            <>
              <div class="regimes-plot-row">
                <div>
                  <div class="panel-sub">two starts, ε apart · pointwise forecast fraying</div>
                  <PlotFigure options={pairOptions} />
                </div>
                <div>
                  <div class="panel-sub">error doubles every step (λ = ln 2)</div>
                  <PlotFigure options={divOptions} />
                </div>
                <div>
                  <div class="panel-sub">the climate: occupancy vs the arcsine law</div>
                  <PlotFigure options={invOptions} />
                </div>
              </div>
              <div class="tiles">
                <div class="tile">
                  <div class="tile-value">{LYAPUNOV.toFixed(3)}</div>
                  <div class="tile-label">Lyapunov λ = ln 2</div>
                </div>
                <div class="tile">
                  <div class="tile-value">{cc().div.horizonSteps}</div>
                  <div class="tile-label">forecast horizon (steps)</div>
                </div>
                <div class="tile">
                  <div class="tile-value">10^{perturbation.get().toFixed(1)}</div>
                  <div class="tile-label">initial error ε</div>
                </div>
              </div>
            </>
          );
        }}
      </CellView>

      <div class="controls-grid">
        <ControlSlider of={perturbation} label="log₁₀ ε" format={(v) => `10^${v.toFixed(1)}`} />
      </div>
    </div>
  );
}
