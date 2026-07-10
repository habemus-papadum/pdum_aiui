/**
 * step1.tsx — the playbook's LAYER 1, standing alone: pure functions rendered
 * statically. No cells, no controls, no components — just the math from
 * src/lib/diffusion.ts (already exhaustively tested in diffusion.test.ts and
 * benchmarked in diffusion.bench.ts) drawn once. Compare with step2/step3/the
 * finished app to watch each layer arrive.
 */
import { render } from "@solidjs/web";
import { For } from "solid-js";
import { INITIAL_CONDITIONS, initialProfile } from "../lib/diffusion";
import { profilePoints } from "../ui/ProfileChart";
import "../styles.css";

function Step1() {
  return (
    <div class="app">
      <header class="banner">
        <h1>step 1 · pure functions</h1>
        <p>
          The four initial profiles, straight from <code>lib/diffusion.ts</code> — values in, markup
          out. Nothing recomputes, because nothing can change yet: there are no controls and no
          cells. That is the point of this page.
        </p>
      </header>
      <div class="profile-grid">
        <For each={INITIAL_CONDITIONS}>
          {(kind) => (
            <figure class="profile-chart panel">
              <svg viewBox="0 0 640 220" role="img" aria-label={`${kind} profile`}>
                <polyline class="numeric" points={profilePoints(initialProfile(kind, 257))} />
              </svg>
              <figcaption class="muted">{kind}</figcaption>
            </figure>
          )}
        </For>
      </div>
      <p class="muted">
        next: <a href="/step2.html">step 2 — the control surface and the cells</a>
      </p>
    </div>
  );
}

render(() => <Step1 />, document.getElementById("root") as HTMLElement);
