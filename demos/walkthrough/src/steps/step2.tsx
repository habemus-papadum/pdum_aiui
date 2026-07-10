/**
 * step2.tsx — LAYER 2 arrives: the control surface (store.ts) and the cells
 * (graph.ts), with the barest possible rendering — a raw polyline inside one
 * CellView. No designed components yet: the point of this page is that the
 * app is already ALIVE and steerable — drag κ mid-run and the worker cancels
 * and restarts; open the console and drive it exactly as an agent would:
 *
 *   __walkthrough.call("report")
 *   __walkthrough.call("set", { name: "kappa", value: 0.8 })
 *   __walkthrough.call("re-seed")
 */
import { CellView, ControlSlider } from "@habemus-papadum/aiui-viz";
import { render } from "@solidjs/web";
import { For } from "solid-js";
import type { InitialCondition } from "../lib/diffusion";
import { graph } from "../model/graph";
import { ic, kappa, points, simTime } from "../model/store";
import { profilePoints } from "../ui/ProfileChart";
import "../styles.css";

function Step2() {
  return (
    <div class="app">
      <header class="banner">
        <h1>step 2 · controls + cells</h1>
        <p>
          The independent variables became <code>control()</code>s, the evolution became a streaming
          worker cell, and the derived tools are live — try{" "}
          <code>__walkthrough.call("report")</code> in the console. Rendering is deliberately crude;
          that is step 3's job.
        </p>
      </header>
      <div class="controls panel">
        <ControlSlider of={kappa} label="diffusion κ" format={(v) => v.toFixed(2)} />
        <ControlSlider of={points} label="resolution" format={(v) => `${v} pts`} />
        <ControlSlider of={simTime} label="duration" format={(v) => `${v.toFixed(3)} s`} />
        <label class="select" data-control={ic.name}>
          <span class="slider-label">profile</span>
          <select
            value={ic.get()}
            onInput={(e) => ic.set(e.currentTarget.value as InitialCondition)}
          >
            <For each={ic.meta.options}>{(kind) => <option value={kind}>{kind}</option>}</For>
          </select>
        </label>
      </div>
      <section class="panel">
        <CellView of={graph().profile} label="marching the rod">
          {(p) => (
            <figure class="profile-chart">
              <svg viewBox="0 0 640 220" role="img" aria-label="temperature profile">
                <polyline class="numeric" points={profilePoints(p().u)} />
              </svg>
              <figcaption class="muted">u(x) at t = {p().t.toFixed(4)} s</figcaption>
            </figure>
          )}
        </CellView>
      </section>
      <p class="muted">
        next: <a href="/step3.html">step 3 — designed components</a>
      </p>
    </div>
  );
}

render(() => <Step2 />, document.getElementById("root") as HTMLElement);
