/**
 * ProfileChart.tsx — the temperature profile as an SVG polyline (playbook
 * layer 3): a pure reader — profile in, markup out, no state, no logic that
 * belongs in a cell. The optional dashed overlay is the analytic reference.
 */
import { Show } from "solid-js";

const W = 640;
const H = 220;
const PAD = 10;

/** Map a profile to SVG polyline points (u ∈ [0, 1.1] → viewport). */
export function profilePoints(u: Float64Array | number[]): string {
  const n = u.length;
  const pts: string[] = [];
  for (let i = 0; i < n; i++) {
    const x = PAD + (i / (n - 1)) * (W - 2 * PAD);
    const y = H - PAD - (Math.min(1.1, Math.max(0, u[i])) / 1.1) * (H - 2 * PAD);
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return pts.join(" ");
}

export function ProfileChart(props: {
  profile: { t: number; u: Float64Array };
  reference?: Float64Array;
}) {
  return (
    <figure class="profile-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="temperature profile u(x)">
        <line class="axis" x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} />
        <Show when={props.reference}>
          {(ref) => <polyline class="reference" points={profilePoints(ref())} />}
        </Show>
        <polyline class="numeric" points={profilePoints(props.profile.u)} />
      </svg>
      <figcaption class="muted">u(x) at t = {props.profile.t.toFixed(4)} s</figcaption>
    </figure>
  );
}
