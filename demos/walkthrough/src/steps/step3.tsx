/**
 * step3.tsx — LAYER 3: designed components replace the crude rendering. Each
 * one is a pure reader (cells in via graph(), markup out): the profile chart
 * with its dashed analytic overlay, the space-time heatmap (an imperative
 * canvas behind an effect bridge), the gated error readout. Same cells as
 * step 2 — only the presentation grew.
 */
import { CellView } from "@habemus-papadum/aiui-viz";
import { render } from "@solidjs/web";
import { Show } from "solid-js";
import { analyticGaussian } from "../lib/diffusion";
import { graph } from "../model/graph";
import { ic, kappa, points } from "../model/store";
import { Controls } from "../ui/Controls";
import { ErrorReadout } from "../ui/ErrorReadout";
import { ProfileChart } from "../ui/ProfileChart";
import { SpaceTimeMap } from "../ui/SpaceTimeMap";
import "../styles.css";

function Step3() {
  const reference = () =>
    ic.get() === "gaussian"
      ? analyticGaussian(points.get(), graph().profile.latest()?.t ?? 0, kappa.get())
      : undefined;
  return (
    <div class="app">
      <header class="banner">
        <h1>step 3 · designed components</h1>
        <p>
          The same cells as step 2, now worn well: numeric profile with the analytic reference
          dashed behind it (gaussian only), the whole run as a space-time picture, and the error
          norms — a cell that <em>holds</em> when there is nothing to compare against.
        </p>
      </header>
      <Controls />
      <section class="panel">
        <CellView of={graph().profile} label="marching the rod">
          {(p) => (
            <Show when={p()}>
              <ProfileChart profile={p()} reference={reference()} />
            </Show>
          )}
        </CellView>
        <ErrorReadout />
      </section>
      <section class="panel">
        <CellView of={graph().evolution} label="collecting the space-time picture">
          {(e) => <SpaceTimeMap evolution={e()} />}
        </CellView>
      </section>
      <p class="muted">
        next: <a href="/">the finished page — layout, prose, and keys</a>
      </p>
    </div>
  );
}

render(() => <Step3 />, document.getElementById("root") as HTMLElement);
