/**
 * SpectralPanel.tsx — §5: spectral bias, scrubbed by hand.
 *
 * Gradient flow on least squares decouples in the kernel's eigenbasis: mode k
 * is learned on timescale k². Scrub training time and watch the fit sharpen
 * like a progressive JPEG — coarse modes first, fine detail polynomially
 * later. The α knob shapes the target's spectrum: smooth targets put their
 * energy where gradient descent is fast; a white spectrum leaves most of it
 * where descent essentially never arrives.
 */
import { chart, plot as plotInk, plotStyle } from "@habemus-papadum/aiui-journal";
import { CellView, ControlSlider } from "@habemus-papadum/aiui-viz";
import { PlotFigure } from "@habemus-papadum/aiui-viz/plot";
import * as Plot from "@observablehq/plot";
import { graph } from "../model/graph";
import { smoothness, trainTime } from "../model/store";

export function SpectralPanel() {
  return (
    <div class="panel">
      <div class="panel-head">
        <h2>gradient descent in the eigenbasis</h2>
        <span class="legend">
          <i style={{ background: chart().green }} /> target
          <i style={{ background: chart().blue }} /> learned
        </span>
      </div>

      <CellView of={graph().spectral} label="spectral">
        {(ss) => {
          const curveOptions = (): Plot.PlotOptions => {
            const s = ss().state;
            const rows = s.x.map((x, i) => ({ x, target: s.fTarget[i], learned: s.fLearned[i] }));
            return {
              height: 240,
              style: plotStyle(),
              x: { label: "x" },
              y: { label: "f(x)", grid: true },
              marks: [
                Plot.lineY(rows, { x: "x", y: "target", stroke: chart().green, strokeWidth: 1.5 }),
                Plot.lineY(rows, { x: "x", y: "learned", stroke: chart().blue, strokeWidth: 2 }),
              ],
            };
          };

          const modeOptions = (): Plot.PlotOptions => {
            const s = ss().state;
            const rows = s.k.map((k, i) => ({
              k,
              target: s.target[i],
              learned: s.learned[i],
            }));
            return {
              height: 240,
              style: plotStyle(),
              x: { label: "mode k (frequency)" },
              y: { label: "amplitude", grid: true },
              marks: [
                Plot.barY(rows, {
                  x: "k",
                  y: "target",
                  fill: chart().green,
                  fillOpacity: 0.25,
                }),
                Plot.barY(rows, { x: "k", y: "learned", fill: chart().blue, fillOpacity: 0.85 }),
              ],
            };
          };

          const lossOptions = (): Plot.PlotOptions => {
            const c = ss().curve;
            const rows = c.t.map((t, i) => ({ t, loss: c.loss[i] }));
            return {
              height: 240,
              style: plotStyle(),
              x: {
                label: "training time t",
                type: "log",
                tickFormat: (d: number) => (d >= 1 ? String(d) : d.toPrecision(1)),
              },
              y: {
                label: "loss",
                type: "log",
                grid: true,
                domain: [Math.max(1e-6, Math.min(...rows.map((r) => r.loss))), rows[0].loss * 1.5],
                clamp: true,
                tickFormat: (d: number) => (d >= 0.01 ? String(d) : d.toExponential(0)),
              },
              marks: [
                Plot.lineY(rows, { x: "t", y: "loss", stroke: chart().purple, strokeWidth: 2 }),
                Plot.ruleX([ss().t], { stroke: plotInk().strong, strokeDasharray: "3 3" }),
              ],
            };
          };

          return (
            <div class="regimes-plot-row">
              <div>
                <div class="panel-sub">the fit at time t (progressive JPEG)</div>
                <PlotFigure options={curveOptions} />
              </div>
              <div>
                <div class="panel-sub">per-mode progress · slow modes are fine detail</div>
                <PlotFigure options={modeOptions} />
              </div>
              <div>
                <div class="panel-sub">training curve · you are the marker</div>
                <PlotFigure options={lossOptions} />
              </div>
            </div>
          );
        }}
      </CellView>

      <div class="controls-grid">
        <ControlSlider of={trainTime} label="training time" format={(v) => `10^${v.toFixed(1)}`} />
        <ControlSlider of={smoothness} label="target smoothness α" format={(v) => v.toFixed(2)} />
      </div>
    </div>
  );
}
