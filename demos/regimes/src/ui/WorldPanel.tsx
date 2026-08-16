/**
 * WorldPanel.tsx — §2: the regression simulator y = f(x) + σ·ε, seen honestly.
 *
 * One drawn dataset (dots), the truth f (line), and the ±σ / ±2σ noise band
 * around it — the randomness no model will ever remove. The tiles put numbers
 * on "signal" (Var f), the floor (σ²), and their ratio (SNR).
 */
import { chart, plot as plotInk, plotStyle } from "@habemus-papadum/aiui-journal";
import { CellView, ControlSlider } from "@habemus-papadum/aiui-viz";
import { PlotFigure } from "@habemus-papadum/aiui-viz/plot";
import * as Plot from "@observablehq/plot";
import { graph, reseed } from "../model/graph";
import { grid, trueF } from "../model/regress";
import { noise, samples } from "../model/store";

export function WorldPanel() {
  return (
    <div class="panel">
      <div class="panel-head">
        <h2>the simulator</h2>
        <span class="legend">
          <i style={{ background: chart().green }} /> truth f
          <i style={{ background: chart().blue }} /> samples
        </span>
      </div>

      <CellView of={graph().world} label="simulator">
        {(w) => {
          const options = (): Plot.PlotOptions => {
            const v = w();
            const xs = grid(201);
            const band = xs.map((x) => ({ x, f: trueF(x), sigma: v.sigma }));
            const pts = v.data.xs.map((x, i) => ({ x, y: v.data.ys[i] }));
            return {
              height: 260,
              style: plotStyle(),
              x: { label: "x" },
              y: { label: "y", grid: true },
              marks: [
                Plot.areaY(band, {
                  x: "x",
                  y1: (r: { f: number; sigma: number }) => r.f - 2 * r.sigma,
                  y2: (r: { f: number; sigma: number }) => r.f + 2 * r.sigma,
                  fill: chart().green,
                  fillOpacity: 0.08,
                }),
                Plot.areaY(band, {
                  x: "x",
                  y1: (r: { f: number; sigma: number }) => r.f - r.sigma,
                  y2: (r: { f: number; sigma: number }) => r.f + r.sigma,
                  fill: chart().green,
                  fillOpacity: 0.14,
                }),
                Plot.dot(pts, { x: "x", y: "y", fill: chart().blue, r: 2.4, fillOpacity: 0.8 }),
                Plot.lineY(band, { x: "x", y: "f", stroke: chart().green, strokeWidth: 2 }),
                Plot.ruleY([0], { stroke: plotInk().rule }),
              ],
            };
          };

          const snr = () => w().signal / (w().sigma * w().sigma);
          return (
            <>
              <PlotFigure options={options} />
              <div class="tiles">
                <div class="tile">
                  <div class="tile-value">{w().signal.toFixed(2)}</div>
                  <div class="tile-label">signal · Var f(x)</div>
                </div>
                <div class="tile">
                  <div class="tile-value">{(w().sigma * w().sigma).toFixed(3)}</div>
                  <div class="tile-label">noise floor · σ²</div>
                </div>
                <div class="tile">
                  <div class="tile-value">{snr().toFixed(1)}</div>
                  <div class="tile-label">SNR · Var f / σ²</div>
                </div>
              </div>
            </>
          );
        }}
      </CellView>

      <div class="controls-grid">
        <ControlSlider of={noise} label="noise σ" format={(v) => v.toFixed(2)} />
        <ControlSlider of={samples} label="samples n" format={(v) => `${v}`} />
      </div>
      <div class="controls-buttons">
        <button type="button" class="btn btn-outline" onClick={() => reseed()}>
          reseed
        </button>
      </div>
    </div>
  );
}
