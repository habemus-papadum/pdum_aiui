/**
 * App.tsx — layout, arranged as a paper with a dashboard on top. The first
 * section is the full overview (every panel at a glance); the later sections
 * re-render their OWN instances of the same widgets (the frozen-fraction chart,
 * the permanents panel) beside the prose that explains them. Double-mounting is
 * safe and deliberate: every panel is a pure reader of the shared durable
 * cells/signals, so both copies stay in lockstep. The exception is the durable
 * canvas — a DOM singleton — which lives only in the overview.
 */

import { TeX, TocRail } from "@habemus-papadum/aiui-viz/site";
import { AztecCanvas } from "./AztecCanvas";
import { Controls } from "./Controls";
import { FrozenChart } from "./FrozenChart";
import { Legend } from "./Legend";
import { Permanents } from "./Permanents";
import { Tiles } from "./Tiles";

export function App() {
  return (
    <>
      <div class="app">
        <div class="app-main">
          <header class="app-head">
            <h1>
              <span class="accent">aztec</span> · the arctic circle
            </h1>
            <p class="app-sub">
              A uniformly-random domino tiling of the Aztec diamond, and the theorem hiding in it.
            </p>
          </header>

          <section id="the-tiling" class="page-section">
            <h2>the tiling</h2>
            <p class="section-lead">
              A uniformly-random domino tiling of the Aztec diamond AD(n), grown by{" "}
              <b>EKLP domino shuffling</b>: destroy facing pairs, slide every domino one step, and
              fill the gaps that open up by fair coin flips. Watch the fold — the four corners
              freeze into brickwork while a disordered disc churns in the middle. The controls drive
              the growth; the <span class="ctrl">fold</span> scrubber walks it by hand. The sections
              below revisit the arctic circle and the permanent connection with their proofs
              (re-rendering the same live panels).
            </p>
            <div class="layout">
              <div class="col-sim">
                <AztecCanvas />
                <Legend />
                <Controls />
              </div>
              <div class="col-data">
                <Tiles />
                <FrozenChart />
                <Permanents />
              </div>
            </div>
          </section>

          <section id="the-arctic-circle" class="page-section">
            <h2>the arctic circle</h2>
            <p class="section-lead">
              Away from the centre the tiling freezes: each corner fills with a single domino type
              in perfect brickwork — the <b>frozen</b> (polar) regions. Only a disc in the middle
              stays disordered. The frozen-fraction curve is that fact as a number: the share of
              dominoes lying outside the circle and matching their corner, climbing toward 1 as the
              diamond grows.
            </p>
            <FrozenChart />
            <p class="prose">
              The <b>Arctic Circle Theorem</b> (Jockusch, Propp &amp; Shor, 1998) makes the boundary
              exact. Rescale AD(n) to the unit square; as <TeX tex="n \to \infty" /> the interface
              between the frozen corners and the disordered disc converges, with probability 1, to
              the inscribed circle — in cell coordinates the circle of radius{" "}
              <TeX tex="n/\sqrt{2}" /> about the centre:
            </p>
            <TeX display tex="x^2 + y^2 = \frac{n^2}{2}" />
            <p class="prose muted">
              Turn on the arctic-circle overlay and grow n: the dashed circle hugs the frozen
              boundary more and more tightly.
            </p>
          </section>

          <section id="tilings-and-permanents" class="page-section">
            <h2>tilings and permanents</h2>
            <p class="section-lead">
              Counting the domino tilings of AD(n) is counting perfect matchings of its dual graph,
              which is the <b>permanent</b> of the black×white biadjacency matrix A — the
              determinant without the alternating signs:
            </p>
            <TeX
              display
              tex="\operatorname{per}(A) = \sum_{\sigma \in S_n} \prod_{i=1}^{n} a_{i,\sigma(i)}"
            />
            <p class="prose">
              That missing cancellation is exactly what makes the permanent <b>#P-hard</b> in
              general. Yet for the Aztec diamond the count collapses to a closed form (EKLP):
            </p>
            <TeX display tex="\#\,\text{tilings}\big(\mathrm{AD}(n)\big) = 2^{\,n(n+1)/2}" />
            <p class="prose">
              The panel below computes the permanent bare-handed with Ryser's inclusion–exclusion
              formula and checks it against that closed form, for n = 1..4.
            </p>
            <Permanents />
          </section>

          <section id="experiments" class="page-section">
            <h2>experiments</h2>
            <p class="section-lead">Things to try — each names the exact control.</p>
            <ul class="experiments">
              <li>
                Hit <span class="ctrl">play</span> to pause, then drag the{" "}
                <span class="ctrl">fold</span> scrubber to walk the shuffle a step at a time — the
                arctic circle grows out of nothing and the corners freeze frame by frame.
              </li>
              <li>
                Press <span class="ctrl">regrow</span> at the same <span class="ctrl">order n</span>{" "}
                to draw a different sample: the frozen corners are fixed by the theorem, but the
                disordered disc comes out different every time.
              </li>
              <li>
                Compare small vs large <span class="ctrl">order n</span>: at AD(4) the frozen edge
                is ragged; push n up and it sharpens toward the smooth inscribed circle.
              </li>
              <li>
                Toggle the <span class="ctrl">arctic circle</span> overlay and slide{" "}
                <span class="ctrl">order n</span> — the dashed circle of radius n/√2 tracks the
                frozen boundary ever more tightly.
              </li>
              <li>
                Growth is deterministic in its seed: the <span class="ctrl">regrow</span> agent tool
                accepts a fixed <b>seed</b>, and replaying it reproduces the identical tiling — same
                disorder, same corners.
              </li>
            </ul>
          </section>
        </div>
        <TocRail />
      </div>
    </>
  );
}
