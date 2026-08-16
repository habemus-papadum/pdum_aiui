/**
 * DecompPanel.tsx — §3: the four-term decomposition, measured live.
 *
 * Left: what the Monte-Carlo actually looks like — 12 refits on independent
 * draws (the visible wobble = estimation), their best-in-family target (dashed
 * = what the family could ever express; its gap to the truth = approximation),
 * and the truth. Right: the terms stacked into the expected test loss, with
 * the dominant-term diagnosis. The exact least-squares solver keeps the
 * optimization term at zero — §5 gives that term its own stage.
 */
import { chart, plot as plotInk, plotStyle } from "@habemus-papadum/aiui-journal";
import { CellView, ControlSlider } from "@habemus-papadum/aiui-viz";
import { PlotFigure } from "@habemus-papadum/aiui-viz/plot";
import * as Plot from "@observablehq/plot";
import { graph } from "../model/graph";
import type { Decomposition } from "../model/regress";
import { degree, noise, samples } from "../model/store";

function fmt(v: number): string {
  if (v === 0) return "0";
  if (v >= 100 || v < 0.001) return v.toExponential(1);
  return v.toFixed(3);
}

const REGIME_COPY: Record<Decomposition["dominant"], string> = {
  approximation: "approximation-limited — the family cannot express f; buy capacity, not data",
  estimation:
    "estimation-limited — the data cannot pin the family down; buy data, shrink, or ensemble",
  balanced: "balanced — neither term dominates; both knobs still pay",
};

function DecompBar(props: { d: Decomposition }) {
  const parts = () => [
    { key: "noise floor σ²", value: props.d.floor, color: plotInk().rule },
    { key: "approximation", value: props.d.approximation, color: chart().purple },
    { key: "estimation", value: props.d.estimation, color: chart().blue },
  ];
  const total = () => Math.max(1e-12, props.d.total);
  return (
    <div class="regimes-decomp">
      <div class="regimes-bar" role="img" aria-label="loss decomposition">
        {parts().map((p) => (
          <div
            class="regimes-bar-seg"
            style={{
              width: `${(100 * p.value) / total()}%`,
              background: p.color,
            }}
            title={`${p.key}: ${fmt(p.value)}`}
          />
        ))}
      </div>
      <div class="regimes-bar-rows">
        {parts().map((p) => (
          <div class="regimes-bar-row">
            <i style={{ background: p.color }} />
            <span>{p.key}</span>
            <b class="mono">{fmt(p.value)}</b>
            <span class="dim">{((100 * p.value) / total()).toFixed(0)}%</span>
          </div>
        ))}
        <div class="regimes-bar-row">
          <i style={{ background: chart().green }} />
          <span>optimization</span>
          <b class="mono">0</b>
          <span class="dim">exact solver — see §5</span>
        </div>
        <div class="regimes-bar-row regimes-bar-total">
          <i />
          <span>expected test loss</span>
          <b class="mono">{fmt(props.d.total)}</b>
          <span class="dim" />
        </div>
      </div>
    </div>
  );
}

export function DecompPanel() {
  return (
    <div class="panel">
      <div class="panel-head">
        <h2>the decomposition, measured</h2>
        <span class="legend">
          <i style={{ background: chart().green }} /> truth
          <i style={{ background: chart().blue }} /> refits
          <i style={{ background: chart().purple }} /> best-in-family
        </span>
      </div>

      <CellView of={graph().decomp} label="decomposition">
        {(dd) => {
          const fitOptions = (): Plot.PlotOptions => {
            const d = dd();
            const rows = (ys: number[]) => d.x.map((x, i) => ({ x, y: ys[i] }));
            const yMax = 2.2;
            return {
              height: 280,
              style: plotStyle(),
              x: { label: "x" },
              y: { label: "y", domain: [-yMax, yMax], grid: true, clamp: true },
              marks: [
                ...d.sampleFits.map((f) =>
                  Plot.lineY(rows(f), {
                    x: "x",
                    y: "y",
                    stroke: chart().blue,
                    strokeOpacity: 0.25,
                    strokeWidth: 1,
                    clip: true,
                  }),
                ),
                Plot.lineY(rows(d.best), {
                  x: "x",
                  y: "y",
                  stroke: chart().purple,
                  strokeWidth: 2,
                  strokeDasharray: "5 4",
                  clip: true,
                }),
                Plot.lineY(rows(d.fTrue), {
                  x: "x",
                  y: "y",
                  stroke: chart().green,
                  strokeWidth: 2,
                  clip: true,
                }),
              ],
            };
          };

          return (
            <div class="regimes-split">
              <div>
                <div class="panel-sub">12 refits on fresh draws · the wobble is estimation</div>
                <PlotFigure options={fitOptions} />
              </div>
              <div>
                <div class="panel-sub">expected test loss, term by term</div>
                <DecompBar d={dd()} />
                <div class={`regimes-regime regimes-regime-${dd().dominant}`}>
                  {REGIME_COPY[dd().dominant]}
                </div>
              </div>
            </div>
          );
        }}
      </CellView>

      <div class="controls-grid">
        <ControlSlider of={degree} label="family · degree" format={(v) => `${v}`} />
        <ControlSlider of={samples} label="samples n" format={(v) => `${v}`} />
        <ControlSlider of={noise} label="noise σ" format={(v) => v.toFixed(2)} />
      </div>
    </div>
  );
}
