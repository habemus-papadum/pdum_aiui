/**
 * App.tsx — layout (playbook layer 4), arranged as a paper with a dashboard on top. The first
 * section is the full overview (every panel at a glance, as it loaded before the
 * paper rewrite); the later sections re-render their OWN instances of the same
 * widgets beside the prose that explains them. That double-mounting is safe and
 * deliberate: every panel is a pure reader of the shared durable cells/signals,
 * so the two copies of a widget stay in lockstep (move a slider in one, the
 * other follows) — a live demonstration of shared reactive state. The one
 * exception is the durable canvas: it is a DOM singleton and lives only in the
 * overview.
 */

import { TeX, TocRail } from "@habemus-papadum/aiui-viz/site";
import { AnalysisPanel } from "./AnalysisPanel";
import { Controls } from "./Controls";
import { RegimeAtlas } from "./RegimeAtlas";
import { RegimeTable } from "./RegimeTable";
import { SimCanvas } from "./SimCanvas";
import { StatsTiles } from "./StatsTiles";
import { TimeSeries } from "./TimeSeries";

export function App() {
  return (
    <>
      <div class="app">
        <div class="app-main">
          <header class="app-head">
            <h1>
              <span class="accent">morphogen</span> · a Turing-pattern laboratory
            </h1>
            <p class="app-sub">
              Gray-Scott reaction–diffusion on the GPU — two chemicals, two knobs (feed F, kill k),
              and every pattern regime Pearson catalogued.
            </p>
          </header>

          <section id="the-laboratory" class="page-section">
            <h2>the laboratory</h2>
            <p class="section-lead">
              Everything at a glance — the field and its controls, the live observables, the
              structure analysis, and the (F, k) atlas — all reading the one running simulation
              through a reactive cell graph. Drag on the field to inject chemical V; click anywhere
              in the atlas, or a catalog row, to travel to a named regime. The sections below
              revisit each panel with the science behind it, re-rendering the same live widgets —
              move a control there and it moves here too.
            </p>
            <div class="layout">
              <div class="col-sim">
                <SimCanvas />
                <Controls />
                <StatsTiles />
              </div>
              <div class="col-data">
                <TimeSeries />
                <AnalysisPanel />
                <RegimeAtlas />
              </div>
            </div>
            <RegimeTable />
          </section>

          <section id="observables" class="page-section">
            <h2>observables</h2>
            <p class="section-lead">
              Two scalar read-outs of the whole field, sampled at 4 Hz. <b>Coverage</b> is the
              fraction of the plate above the V threshold — how much of the field the pattern
              occupies; <b>contrast</b> is the standard deviation of V — how sharply spots and
              stripes stand out from the background. Watch them settle as a regime locks in, or
              crash when a parameter jump knocks the system off its attractor.
            </p>
            <StatsTiles />
            <TimeSeries />
          </section>

          <section id="structure-analysis" class="page-section">
            <h2>structure analysis</h2>
            <p class="section-lead">
              A heavier pass, run in a worker so the simulation never stutters. It labels the
              connected components (the individual spots) and reports the <b>census</b> — how many,
              their mean area, the largest as a fraction of the field — then computes the radial
              autocorrelation, whose first off-origin peak is the pattern's characteristic{" "}
              <b>wavelength</b> λ: the centre-to-centre spacing the dynamics selected.
            </p>
            <AnalysisPanel />
          </section>

          <section id="theory" class="page-section">
            <h2>theory</h2>
            <p class="prose">
              Two chemicals U and V diffuse and react. V catalyses its own production by consuming U
              (the autocatalytic step <TeX tex="U + 2V \to 3V" />
              ), while U is fed in and V decays — the Gray-Scott system:
            </p>
            <TeX
              display
              tex="\frac{\partial u}{\partial t} = D_u\,\nabla^2 u \;-\; u v^2 \;+\; F(1-u)"
            />
            <TeX
              display
              tex="\frac{\partial v}{\partial t} = D_v\,\nabla^2 v \;+\; u v^2 \;-\; (F+k)\,v"
            />
            <p class="prose">
              <b>F</b> is the <i>feed</i> rate — how fast fresh U is replenished and V washed out
              (the <TeX tex="F(1-u)" /> source and part of the <TeX tex="-(F+k)v" /> sink). <b>k</b>{" "}
              is the extra <i>kill</i> rate on V. Together they place the reaction between
              extinction and runaway, and which regime you land in is almost entirely a function of
              the pair (F, k) — which is why the atlas above is a map of behaviour.
            </p>
            <p class="prose">
              Because V diffuses slower than U (<TeX tex="D_v < D_u" />; here{" "}
              <TeX tex="D_u = 1,\; D_v = 0.5" />
              ), a local surplus of V builds in place while its inhibitor spreads away faster than
              it can suppress it — the short-range activator / long-range inhibitor imbalance behind
              a <b>Turing instability</b>. A spatially uniform steady state, stable against uniform
              perturbations, goes unstable to perturbations at a preferred{" "}
              <i>non-zero wavenumber</i>, so the system spontaneously selects a finite length scale
              — the wavelength λ measured above. It is fixed by the diffusion lengths, not the box:
              the same spacing appears whatever the grid size.
            </p>
          </section>

          <section id="experiments" class="page-section">
            <h2>experiments</h2>
            <p class="section-lead">Things to try — each names the exact control.</p>
            <ul class="experiments">
              <li>
                Jump to <b>mitosis</b> in the <span class="ctrl">regime catalog</span> and watch a
                spot elongate and pinch into two; the <span class="ctrl">spots</span> tile in the
                observables ticks up as it divides.
              </li>
              <li>
                Set <span class="ctrl">speed</span> to <b>paused</b>, then drag on the field with
                the <span class="ctrl">brush</span> — each stroke lands a single step, so you can
                paint V by hand and seed your own pattern.
              </li>
              <li>
                Hold <span class="ctrl">feed F</span> fixed and slide{" "}
                <span class="ctrl">kill k</span> slowly across ~0.06: you cross the spot ↔ stripe
                boundary and the whole field re-sorts.
              </li>
              <li>
                Break a settled pattern with a hard parameter jump — click a far corner of the{" "}
                <span class="ctrl">regime atlas</span> — and watch <b>coverage</b> collapse in the
                time-series before a new regime forms.
              </li>
              <li>
                With <span class="ctrl">auto</span> on, crank <span class="ctrl">thoroughness</span>{" "}
                mid-analysis and watch the progress stripe restart — the in-flight worker run is
                superseded and cancelled, the last result held on screen until the new one lands.
              </li>
              <li>
                Toggle <span class="ctrl">fail next fetch</span> in the catalog and hit{" "}
                <span class="ctrl">re-download</span> to see the cell's error box and its Retry,
                then the table stream back in packet by packet.
              </li>
            </ul>
          </section>
        </div>
        <TocRail />
      </div>
    </>
  );
}
