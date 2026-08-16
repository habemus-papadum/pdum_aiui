/**
 * App.tsx — the regimes notebook (playbook layer 4): a paper-shaped page.
 *
 * The thesis, from the conversation this notebook unpacks: "how hard is this
 * data" is ill-posed until you fix (1) which prediction game you are playing —
 * pointwise or distributional — and (2) which term of
 * loss = floor + approximation + estimation + optimization dominates. Each
 * section stages one concept on a tiny, honest simulator; every number on the
 * page is measured live from code-generated data, never quoted.
 */
import { TeX, TocRail } from "@habemus-papadum/aiui-viz/site";
import { ChaosPanel } from "./ChaosPanel";
import { DecompPanel } from "./DecompPanel";
import { DiePanel } from "./DiePanel";
import { EnsemblePanel } from "./EnsemblePanel";
import { SpectralPanel } from "./SpectralPanel";
import { WorldPanel } from "./WorldPanel";

export function App() {
  return (
    <div class="app regimes">
      <div class="app-main">
        <header class="app-head">
          <h1>
            <span class="accent">regimes</span> · which error owns your loss?
          </h1>
          <p class="app-sub">
            Pretend every dataset is the output of some computer simulation — a random number
            generator, a physics engine, a market, humanity writing text. Before asking{" "}
            <i>"is this data hard to model?"</i> you must fix two things, or the question has no
            answer: <b>which game</b> you are playing (predict the next value, or predict its
            distribution), and <b>which term</b> of the loss you are losing to. This notebook builds
            both ideas from the smallest simulators that exhibit them — a die, a wiggly curve plus
            noise, a five-character chaotic map — with every quantity measured live from freshly
            generated data.
          </p>
        </header>

        {/* ── §1 ────────────────────────────────────────────────────────── */}
        <section id="two-games" class="page-section">
          <h2>§1 · two games: pointwise vs distributional</h2>
          <p class="section-lead">
            The simplest simulator is a die roll. Game 1 — <b>pointwise</b> — asks you to call the
            next face; game 2 — <b>distributional</b> — asks you to state the probabilities and
            scores you by log loss. A fair die is <i>maximally hard</i> at game 1 (nobody beats an
            83% error rate) and <i>maximally easy</i> at game 2 ("uniform" is a one-line model
            already sitting on the floor). That is the whole resolution of the RNG paradox: a random
            number generator seemed both the simplest program and the hardest to model because two
            different questions were being graded as one. A casino has zero pointwise ability and a
            perfect distributional model — and it prints money.
          </p>
          <DiePanel />
          <ul class="experiments">
            <li>
              Set <b>loadedness</b> to 0. The pointwise error pins to its floor 5/6; the log loss
              sits exactly on H = log₂6 ≈ 2.58 bits. Hard and easy at the same time.
            </li>
            <li>
              Drag <b>loadedness</b> toward 1. Both floors fall together to zero — the die becomes
              predictable in both games at once.
            </li>
            <li>
              The green dots (observed frequencies) wobble around the blue bars at small{" "}
              <b>rolls</b> and settle onto them at large — your first glimpse of{" "}
              <i>estimation error</i> shrinking with sample size (§3).
            </li>
          </ul>
        </section>

        {/* ── §2 ────────────────────────────────────────────────────────── */}
        <section id="floor" class="page-section">
          <h2>§2 · signal, noise, and the floor</h2>
          <p class="section-lead">
            Now a simulator with structure worth learning:{" "}
            <TeX tex="y = f(x) + \sigma\,\varepsilon" />, a fixed smooth truth plus injected
            randomness. The <b>noise floor</b> is σ² — the simulator's own coin flips, which no
            model, however large, removes: the best possible model predicts f exactly and still pays
            σ² on every test point. The <b>signal</b> is the variance of f — structure a model can
            actually extract. Note the floor is a property of the <i>generator</i>, not of your
            model: text has a high floor ("my favorite color is ___" is irreducibly uncertain),
            which is why LLM loss plateaus far above zero even as the models grow enormous.
          </p>
          <WorldPanel />
          <ul class="experiments">
            <li>
              Crank <b>noise σ</b> up and watch the band swallow the wiggles: the SNR tile is signal
              ÷ floor, and past σ ≈ 1 the fine structure of f is genuinely buried.
            </li>
            <li>
              <b>samples n</b> changes the density of dots but not the band: n fights estimation
              error (§3), never the floor.
            </li>
            <li>
              Hit <b>reseed</b> — a fresh draw from the same program. Everything that changes is
              noise; everything that persists is signal.
            </li>
          </ul>
        </section>

        {/* ── §3 ────────────────────────────────────────────────────────── */}
        <section id="decomposition" class="page-section">
          <h2>§3 · the master equation, measured</h2>
          <p class="section-lead">
            Fit polynomials of degree d to n noisy samples, many times, on fresh draws each time.
            Everything this notebook cares about is in the decomposition
          </p>
          <TeX
            display
            tex="\underbrace{\text{loss}}_{\text{test MSE}} \;=\; \underbrace{\sigma^2}_{\text{floor}} \;+\; \underbrace{\lVert f_{\text{best}} - f \rVert^2}_{\text{approximation}} \;+\; \underbrace{\mathbb{E}\,\lVert \hat f - f_{\text{best}} \rVert^2}_{\text{estimation}} \;+\; \underbrace{\vphantom{\lVert f \rVert^2}0}_{\text{optimization}}"
          />
          <p class="section-lead">
            <b>Approximation</b>: the family cannot express the truth — the dashed best-in-family
            curve misses the fine wiggle no matter how much data arrives (fitting a sine with
            straight lines). <b>Estimation</b>: finite noisy data cannot pin down which family
            member is right — refit on a fresh draw and the answer wobbles; the spaghetti <i>is</i>{" "}
            that wobble. <b>Optimization</b> is held at zero here by using an exact solver — §5
            gives it a stage of its own. Diagnosing which term dominates is the whole strategic
            game: the same loss number can mean "buy a bigger model" or "buy more data", and the two
            prescriptions point in opposite directions.
          </p>
          <DecompPanel />
          <ul class="experiments">
            <li>
              <b>degree</b> 2, <b>samples</b> 500: the spaghetti collapses onto the dashed curve —
              agreement without truth. Approximation-limited: more data is useless; capacity pays.
            </li>
            <li>
              <b>degree</b> 13, <b>samples</b> 30: the spaghetti explodes — each refit is a
              different fantasy. Estimation-limited, catastrophically; this is overfitting seen as a
              variance term.
            </li>
            <li>
              Fix any setting and sweep <b>degree</b> 1 → 14: approximation falls, estimation rises.
              The classical bias–variance tradeoff is just this bar chart re-balancing.
            </li>
          </ul>
        </section>

        {/* ── §4 ────────────────────────────────────────────────────────── */}
        <section id="ensembling" class="page-section">
          <h2>§4 · ensembling is an estimation-term weapon</h2>
          <p class="section-lead">
            Average M models with roughly independent errors and the estimation term shrinks like
            1/M — Galton's fairground crowd guessing the ox's weight. Nothing else moves: the floor
            is untouchable and averaging cannot express what no member can, so the curve slams into
            the dashed floor-plus-approximation line. This is the resolution of the original claim
            "ensembling works in low-SNR regimes": ensembling pays exactly when the estimation term
            is comparable to the signal — scarce, noisy data leaving many candidate models alive —
            and is redundant once data has collapsed the posterior onto one family (then you pour
            all capacity into one model instead). The <b>disagreement</b> tile is the deployable
            diagnostic: variance across members needs no ground truth, and it estimates how diffuse
            your posterior still is.
          </p>
          <EnsemblePanel />
          <ul class="experiments">
            <li>
              <b>degree</b> 10, <b>samples</b> 60: a steep 1/M dive — committee territory. Note how
              well the disagreement tile tracks the gap left to close.
            </li>
            <li>
              <b>degree</b> 2, <b>samples</b> 500: the curve is born flat on the dashed line.
              Averaging clones of a wrong family buys nothing.
            </li>
            <li>
              Toggle <b>heterogeneous members</b>: mixing degrees d−2 … d+2 widens the union of
              families and decorrelates errors — the "models of different types" clause doing its
              double duty.
            </li>
          </ul>
        </section>

        {/* ── §5 ────────────────────────────────────────────────────────── */}
        <section id="spectral" class="page-section">
          <h2>§5 · the optimization term: spectral bias</h2>
          <p class="section-lead">
            "Can gradient descent even find it?" has a precise cash-out. Expand the target in the
            eigenbasis of a smoothness operator on the data; gradient flow then learns each mode
            independently, at a rate set by its eigenvalue — here mode k arrives on timescale{" "}
            <TeX tex="k^2" />, so the fit sharpens like a progressive JPEG. A smooth target (α = 2)
            keeps its energy in fast modes and trains quickly; a white target (α = 0) smears energy
            across modes gradient descent essentially never reaches — parity problems, crypto, and
            noise-labels live there. "How differentiable is the data" becomes "how fast does the
            target's spectrum decay". And when the geometry is hostile — razor-thin manifolds,
            discrete tokens — we <i>manufacture</i> smoothness: embeddings give tokens a geometry,
            diffusion models blur the data on purpose so the score is learnable, then anneal the
            blur away. Noise added deliberately, to make learning possible.
          </p>
          <SpectralPanel />
          <ul class="experiments">
            <li>
              Scrub <b>training time</b> left to right at α = 1: modes light up strictly left to
              right in the middle panel — coarse structure first, fine detail polynomially later.
            </li>
            <li>
              Set <b>α</b> = 2: the training curve plunges — nearly all energy lives in mode 1. Set{" "}
              <b>α</b> = 0: it stalls on a long plateau — the flat spectrum is the stall.
            </li>
            <li>
              The dashed marker on the training curve is your scrub position: you are standing
              inside the loss curve every deep-learning paper plots.
            </li>
          </ul>
        </section>

        {/* ── §6 ────────────────────────────────────────────────────────── */}
        <section id="horizon" class="page-section">
          <h2>§6 · horizon: when pointwise dies and distributional lives</h2>
          <p class="section-lead">
            The logistic map <TeX tex="x_{n+1} = 4x_n(1-x_n)" /> is a five-character program with
            zero injected noise — fully deterministic — yet any error ε in your knowledge of the
            state doubles every step (Lyapunov exponent λ = ln 2). Pointwise forecasting is perfect
            for a few steps, then dead: the horizon grows only <i>logarithmically</i> in precision,
            so a million-fold better measurement buys about twenty more steps. Weather dies at two
            weeks this way. But the trajectory's <i>statistics</i> — its occupancy density —
            converge to a closed-form invariant law and stay learnable forever: climate outlives
            weather. Learnability is indexed by (dataset, functional, horizon), never by a dataset
            alone — the same simulator is unlearnable and trivially learnable at once, which is
            where §1's two games reappear as the two ends of a term structure.
          </p>
          <ChaosPanel />
          <ul class="experiments">
            <li>
              Sweep <b>log₁₀ ε</b> from −2 to −12: ten orders of magnitude of precision, and the
              horizon marker crawls right by only ~33 steps. Logarithmic returns on measurement.
            </li>
            <li>
              The divergence curve rides the dashed <TeX tex="\varepsilon\, e^{\lambda n}" /> line
              until it saturates — chaos is exponential error growth, seen raw.
            </li>
            <li>
              The histogram ignores ε entirely: the climate never heard about your measurement
              problem.
            </li>
          </ul>
        </section>

        {/* ── §7 ────────────────────────────────────────────────────────── */}
        <section id="laws" class="page-section">
          <h2>§7 · the laws, and how to use them</h2>
          <p class="section-lead">
            Everything above compresses to a diagnostic procedure for real data — where you know
            neither f nor σ:
          </p>
          <table class="regime-table">
            <thead>
              <tr>
                <th>law</th>
                <th>statement</th>
                <th>seen in</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>floor</td>
                <td>
                  Ask "pointwise or distributional?" before "hard or easy?" — no model beats the
                  simulator's injected randomness.
                </td>
                <td>§1, §2</td>
              </tr>
              <tr>
                <td>decomposition</td>
                <td>
                  Excess loss = approximation + estimation + optimization; every famous technique
                  attacks exactly one term. Diagnose before choosing weapons.
                </td>
                <td>§3</td>
              </tr>
              <tr>
                <td>ensembling</td>
                <td>
                  Ensemble across model types while held-out disagreement is high (diffuse
                  posterior); commit everything to one scaled model once data collapses it.
                </td>
                <td>§4</td>
              </tr>
              <tr>
                <td>matching / geometry</td>
                <td>
                  An architecture is a prior over programs; it pays when its structure matches the
                  generator's. Gradient descent extracts the spectrum top-down — engineer smoothness
                  when the geometry is bad.
                </td>
                <td>§5</td>
              </tr>
              <tr>
                <td>compute</td>
                <td>
                  Structure no feasible algorithm can extract is noise in practice: a PRNG is a tiny
                  program AND unlearnable — "learnable" is always relative to a compute budget.
                </td>
                <td>§5's stalled plateau, in spirit</td>
              </tr>
              <tr>
                <td>horizon</td>
                <td>
                  Pointwise predictability decays at a rate set by the dynamics; distributional
                  statistics can outlive trajectories indefinitely.
                </td>
                <td>§6</td>
              </tr>
            </tbody>
          </table>
          <p class="section-lead">
            The field procedure, given only a dataset: hold out data and score a family of cheap,
            <i> different</i> models. If they agree with each other but the loss is high, you are
            approximation-limited (or at the floor) — buy capacity, or accept the floor. If they
            disagree, you are estimation-limited — buy data, shrink, or keep the committee. If a
            bigger optimization budget keeps helping at fixed family and data, you are
            optimization-limited — engineer the geometry. And always check the horizon: the same
            series can be unpredictable per-step and nailed in distribution.
          </p>
        </section>

        <footer class="prose muted">
          Every curve on this page is recomputed live from its controls — the simulators run in your
          tab. Arm the intent client and ask about anything you see.
        </footer>
      </div>
      <TocRail />
    </div>
  );
}
