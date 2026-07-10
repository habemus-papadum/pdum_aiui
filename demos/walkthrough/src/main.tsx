/**
 * main.tsx — LAYER 4: the finished page. Sections that read like a short
 * paper, controls woven into the prose (no knob drawer), a keyboard layer
 * dispatching the SAME registered actions the agent calls, and the hint bar
 * derived from the working keymap. Steps 1-3 remain standing at
 * /step1.html … /step3.html — the same app, one layer at a time.
 */
import { CellView } from "@habemus-papadum/aiui-viz";
import { render } from "@solidjs/web";
import { For, Show } from "solid-js";
import { analyticGaussian } from "./lib/diffusion";
import { graph } from "./model/graph";
import { hints, tap } from "./model/keys";
import { ic, kappa, points } from "./model/store";
import { Controls } from "./ui/Controls";
import { ErrorReadout } from "./ui/ErrorReadout";
import { ProfileChart } from "./ui/ProfileChart";
import { SpaceTimeMap } from "./ui/SpaceTimeMap";
import "./styles.css";

function App() {
  const reference = () =>
    ic.get() === "gaussian"
      ? analyticGaussian(points.get(), graph().profile.latest()?.t ?? 0, kappa.get())
      : undefined;
  return (
    <div class="app">
      <header class="banner">
        <h1>
          heat in a rod — <span class="accent">the playbook, worked</span>
        </h1>
        <p>
          A 1-D diffusion laboratory built in the playbook's order; steps{" "}
          <a href="/step1.html">1</a> · <a href="/step2.html">2</a> · <a href="/step3.html">3</a>{" "}
          are still standing. Keys: <kbd>R</kbd> re-seeds, <kbd>←</kbd>
          <kbd>→</kbd> nudge κ — the same actions and controls the agent drives through{" "}
          <code>report</code>/<code>set</code>.
        </p>
      </header>

      <section class="page-section" id="laboratory">
        <h2>the laboratory</h2>
        <Controls />
        <div class="panel">
          <CellView of={graph().profile} label="marching the rod">
            {(p) => (
              <Show when={p()}>
                <ProfileChart profile={p()} reference={reference()} />
              </Show>
            )}
          </CellView>
          <ErrorReadout />
        </div>
      </section>

      <section class="page-section" id="the-picture">
        <h2>the space-time picture</h2>
        <p class="section-lead">
          Every captured frame stacked downward: diffusion is the picture blurring as you read. Drag{" "}
          <b>κ</b> mid-run — the in-flight march is cancelled (the worker really stops) and the
          picture refills under the new coefficient, streaming row by row.
        </p>
        <div class="panel">
          <CellView of={graph().evolution} label="collecting the space-time picture">
            {(e) => <SpaceTimeMap evolution={e()} />}
          </CellView>
        </div>
      </section>

      <section class="page-section" id="the-math">
        <h2>the math, briefly</h2>
        <p class="section-lead">
          The rod obeys ∂u/∂t = κ·∂²u/∂x² with cold ends. The explicit scheme marches u'ᵢ = uᵢ +
          r(uᵢ₋₁ − 2uᵢ + uᵢ₊₁) at r = κΔt/Δx², stable only for r ≤ ½ — the worker always steps at
          0.9 of that limit, so raising the <b>resolution</b> control quadruples the work each time
          it doubles the points (Δt shrinks with Δx²). For the gaussian profile the free-space
          solution stays gaussian — σ(t) = √(σ₀² + 2κt) — which is what the dashed reference and the
          error norms compare against.
        </p>
      </section>

      <section class="page-section" id="experiments">
        <h2>experiments</h2>
        <ul>
          <li>
            Set <b>profile</b> to <i>step</i> and watch the corners round instantly — diffusion
            kills high frequencies first.
          </li>
          <li>
            Two pulses: the smaller, wider one wins the long game. Why? (Peak height decays like
            1/σ.)
          </li>
          <li>
            Push <b>resolution</b> to 1024 and <b>duration</b> to 0.05 s, then drag κ around —
            cancellation-by-supersession is what keeps that feeling instant.
          </li>
          <li>
            Noise + <kbd>R</kbd>: every seed smooths toward the same nothing. Entropy in one key.
          </li>
        </ul>
      </section>

      <footer class="hints">
        <For each={hints()}>
          {(h) => (
            <button
              type="button"
              class="hint"
              disabled={!h.tapKey}
              onClick={() => h.tapKey && tap(h.tapKey)}
            >
              <kbd>{h.key}</kbd>
              <span class="hint-label">{h.label}</span>
            </button>
          )}
        </For>
      </footer>
    </div>
  );
}

render(() => <App />, document.getElementById("root") as HTMLElement);
