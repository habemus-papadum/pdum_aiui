/**
 * The app-under-test: a small Gaussian **mixture lab** — high-school-level
 * synthetic math, genuinely interactive, deliberately un-busy. Built the way
 * the demo app is built (the frontend-for-agents principles):
 *
 *  - durable ROOTS (module-scope signals) drive derived CELLS
 *    (`cell` from aiui-viz) with explicit `name`/`loc` — the hand-written
 *    equivalent of the babel plugin's injection, since the lab runs no
 *    build-time instrumentation;
 *  - the DOM carries the attribution contract for COMPONENTS by hand
 *    (`data-cell` + `data-source-loc` on region wrappers), while the
 *    element → CELL stamps (`data-cell` = cell name, `data-cell-loc` = the
 *    cell's definition site) are derived automatically at runtime: the plot
 *    paths, the probability readout, and the moments tiles read their cells
 *    through `attributedRead`, and `enableCellAttribution` (armed in
 *    {@link mountScenery}) stamps each rendering element with no `CellView`.
 *    That is exactly what the shot locator, the selection watcher, and VS Code
 *    jump mode resolve against — see aiui-viz/cell-attribution.ts.
 *
 * The one custom widget is the **scrub pill** ({@link NumberPill}): a number
 * you drag horizontally to change — pointer capture, a px→step mapping, and
 * nothing else. Better than a slider for dense parameter rows.
 */

import { attributedRead, cell, enableCellAttribution } from "@habemus-papadum/aiui-viz";
import { render } from "@solidjs/web";
import { createRoot, createSignal } from "solid-js";

// ── the durable roots (the knobs) ─────────────────────────────────────────────
const [mu1, setMu1] = createSignal(-1.2);
const [sigma1, setSigma1] = createSignal(0.8);
const [mu2, setMu2] = createSignal(1.6);
const [sigma2, setSigma2] = createSignal(1.1);
const [weight, setWeight] = createSignal(0.55);
const [lo, setLo] = createSignal(-0.5);
const [hi, setHi] = createSignal(1.5);

// ── the math (pure) ───────────────────────────────────────────────────────────
const SQRT_2PI = Math.sqrt(2 * Math.PI);
const phi = (z: number): number => Math.exp(-0.5 * z * z) / SQRT_2PI;
const pdf1 = (x: number): number => phi((x - mu1()) / sigma1()) / sigma1();
const pdf2 = (x: number): number => phi((x - mu2()) / sigma2()) / sigma2();
const mix = (x: number): number => weight() * pdf1(x) + (1 - weight()) * pdf2(x);

/** Φ(z), the standard normal CDF (Abramowitz–Stegun 7.1.26, |ε| < 1.5e-7). */
function cdf(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const t = 1 / (1 + (0.3275911 * Math.abs(z)) / Math.SQRT2);
  const poly =
    t *
    (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return 0.5 * (1 + sign * (1 - poly * Math.exp(-(z * z) / 2)));
}

const X_MIN = -5;
const X_MAX = 5;
const W = 640;
const H = 240;
const PAD = { l: 40, r: 12, t: 12, b: 26 };
const N = 220;

interface Curves {
  mixture: string;
  c1: string;
  c2: string;
  /** The shaded probability region between lo and hi (a closed polygon). */
  band: string;
  yMax: number;
}

const params = () => ({
  mu1: mu1(),
  s1: sigma1(),
  mu2: mu2(),
  s2: sigma2(),
  w: weight(),
  lo: lo(),
  hi: hi(),
});

// ── the cells (derived, named, located; owned by one module root) ────────────
const { curves, probability, moments } = createRoot(() => {
  const curves = cell(
    params,
    (p): Curves => {
      const xs = Array.from({ length: N }, (_, i) => X_MIN + ((X_MAX - X_MIN) * i) / (N - 1));
      const m = xs.map(mix);
      const yMax = Math.max(...m, ...xs.map(pdf1), ...xs.map(pdf2)) * 1.08;
      const px = (x: number): number =>
        PAD.l + ((x - X_MIN) / (X_MAX - X_MIN)) * (W - PAD.l - PAD.r);
      const py = (y: number): number => H - PAD.b - (y / yMax) * (H - PAD.t - PAD.b);
      const path = (f: (x: number) => number): string =>
        xs
          .map((x, i) => `${i === 0 ? "M" : "L"}${px(x).toFixed(1)},${py(f(x)).toFixed(1)}`)
          .join(" ");
      const a = Math.min(p.lo, p.hi);
      const b = Math.max(p.lo, p.hi);
      const inBand = xs.filter((x) => x >= a && x <= b);
      const bandPts = [a, ...inBand, b];
      const band =
        `M${px(a).toFixed(1)},${py(0).toFixed(1)} ` +
        bandPts.map((x) => `L${px(x).toFixed(1)},${py(mix(x)).toFixed(1)}`).join(" ") +
        ` L${px(b).toFixed(1)},${py(0).toFixed(1)} Z`;
      return { mixture: path(mix), c1: path(pdf1), c2: path(pdf2), band, yMax };
    },
    { name: "curves", loc: "workbench/src/scenery.tsx:78:9" },
  );

  const probability = cell(
    params,
    (p): number => {
      const a = Math.min(p.lo, p.hi);
      const b = Math.max(p.lo, p.hi);
      const comp = (mu: number, s: number): number => cdf((b - mu) / s) - cdf((a - mu) / s);
      return p.w * comp(p.mu1, p.s1) + (1 - p.w) * comp(p.mu2, p.s2);
    },
    { name: "probability", loc: "workbench/src/scenery.tsx:104:9" },
  );

  const moments = cell(
    params,
    (p): { mean: number; sd: number } => {
      const mean = p.w * p.mu1 + (1 - p.w) * p.mu2;
      const ex2 = p.w * (p.s1 * p.s1 + p.mu1 * p.mu1) + (1 - p.w) * (p.s2 * p.s2 + p.mu2 * p.mu2);
      return { mean, sd: Math.sqrt(Math.max(0, ex2 - mean * mean)) };
    },
    { name: "moments", loc: "workbench/src/scenery.tsx:115:9" },
  );

  return { curves, probability, moments };
});

// ── the scrub pill (the widget) ───────────────────────────────────────────────
function NumberPill(props: {
  label: string;
  value: () => number;
  set: (v: number) => void;
  /** Value change per horizontal pixel dragged. */
  step: number;
  min?: number;
  max?: number;
  digits?: number;
  accent?: string;
}) {
  let startX = 0;
  let startValue = 0;
  const clamp = (v: number): number =>
    Math.min(
      props.max ?? Number.POSITIVE_INFINITY,
      Math.max(props.min ?? Number.NEGATIVE_INFINITY, v),
    );
  return (
    <span
      class="gpill"
      style={props.accent ? { "border-color": props.accent } : {}}
      title={`${props.label} — drag to change`}
      onPointerDown={(e: PointerEvent) => {
        startX = e.clientX;
        startValue = props.value();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e: PointerEvent) => {
        if ((e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) {
          props.set(clamp(startValue + (e.clientX - startX) * props.step));
        }
      }}
    >
      <i>{props.label}</i>
      <b>{props.value().toFixed(props.digits ?? 2)}</b>
    </span>
  );
}

// ── the app ───────────────────────────────────────────────────────────────────
function App() {
  const fmtP = () => {
    const p = attributedRead(probability);
    return p === undefined ? "…" : `${(p * 100).toFixed(1)}%`;
  };
  return (
    <div data-cell="AppShell" data-source-loc="workbench/src/scenery.tsx:176:6">
      <header data-cell="Header" data-source-loc="workbench/src/scenery.tsx:177:8">
        <h1>
          <span>gaussians</span> · mixture lab
        </h1>
        <div class="sub">workbench scenery — arm the overlay (`), then talk / draw / shoot</div>
      </header>
      <main>
        <div
          class="card"
          data-cell="MixturePlot"
          data-source-loc="workbench/src/scenery.tsx:184:10"
        >
          {/* viewBox is static "0 0 640 240" (= `0 0 ${W} ${H}`). Every dynamic
              ATTRIBUTE of this component is compiled by Solid into ONE render
              effect; exact runtime cell-attribution pairs that effect's writes
              to its cell reads BY POSITION, so a non-cell dynamic attribute here
              would break the pairing for the paths (it would loud-fail rather
              than mis-stamp — see aiui-viz/cell-attribution.ts). The plot's
              fixed chrome is therefore written as static literals, leaving the
              four path `d`s (each a `curves` read) as the only dynamic
              attributes — so they attribute exactly. */}
          <svg viewBox="0 0 640 240" width="100%" role="img" aria-label="gaussian mixture plot">
            <g stroke="#262c3a">
              <line x1="40" y1="12" x2="40" y2="214" />
              <line x1="40" y1="214" x2="628" y2="214" />
            </g>
            {/* Read the `curves` cell straight into each path. attributedRead
                records the read against this component's attribute effect, and
                enableCellAttribution() (armed in mountScenery) stamps
                data-cell="curves" / data-cell-loc onto each <path> at
                construction — the CellView contract, derived automatically,
                no <Show> or explicit stamp. curves is synchronous, so the value
                is present on the first paint (no loading gate needed). */}
            <path d={attributedRead(curves)?.band ?? ""} fill="#8ab4f81f" stroke="none" />
            <path
              d={attributedRead(curves)?.c1 ?? ""}
              fill="none"
              stroke="#8ab4f8"
              stroke-width="1"
              stroke-dasharray="4 4"
            />
            <path
              d={attributedRead(curves)?.c2 ?? ""}
              fill="none"
              stroke="#7ee0a3"
              stroke-width="1"
              stroke-dasharray="4 4"
            />
            <path
              d={attributedRead(curves)?.mixture ?? ""}
              fill="none"
              stroke="#e8e8ea"
              stroke-width="2"
            />
            {/* Axis labels: positions are static literals (fixed geometry —
                x=PAD.l-6(34)/(W+PAD.l-PAD.r)/2(334)/W-PAD.r(628),
                y=H-PAD.b+12(226)/H-6(234)) so they add no dynamic attribute to
                this component's attribute effect; the {X_MIN}/{X_MAX} text are
                child inserts (their own effects, read no cell) and are inert. */}
            <g fill="#9aa0aa" font-size="10">
              <text x="34" y="226" text-anchor="end">
                {X_MIN}
              </text>
              <text x="334" y="234" text-anchor="middle">
                x
              </text>
              <text x="628" y="226" text-anchor="end">
                {X_MAX}
              </text>
            </g>
          </svg>
          <div class="legend" data-cell="Legend" data-source-loc="workbench/src/scenery.tsx:224:12">
            <span>
              <i style="background:#e8e8ea"></i>mixture
            </span>
            <span>
              <i style="background:#8ab4f8"></i>component 1
            </span>
            <span>
              <i style="background:#7ee0a3"></i>component 2
            </span>
          </div>
          <div
            class="pills"
            data-cell="Controls"
            data-source-loc="workbench/src/scenery.tsx:235:12"
          >
            <NumberPill
              label="μ₁"
              value={mu1}
              set={setMu1}
              step={0.02}
              min={X_MIN}
              max={X_MAX}
              accent="#8ab4f8"
            />
            <NumberPill
              label="σ₁"
              value={sigma1}
              set={setSigma1}
              step={0.01}
              min={0.15}
              max={3}
              accent="#8ab4f8"
            />
            <NumberPill
              label="μ₂"
              value={mu2}
              set={setMu2}
              step={0.02}
              min={X_MIN}
              max={X_MAX}
              accent="#7ee0a3"
            />
            <NumberPill
              label="σ₂"
              value={sigma2}
              set={setSigma2}
              step={0.01}
              min={0.15}
              max={3}
              accent="#7ee0a3"
            />
            <NumberPill label="w" value={weight} set={setWeight} step={0.005} min={0} max={1} />
          </div>
        </div>
        <div
          class="card"
          data-cell="Probability"
          data-source-loc="workbench/src/scenery.tsx:275:10"
        >
          <div class="prob-row">
            <span class="prob-label">
              P(<b>a</b> ≤ X ≤ <b>b</b>) =
            </span>
            <span class="prob-value" data-source-loc="workbench/src/scenery.tsx:283:1">
              {fmtP()}
            </span>
            <NumberPill label="a" value={lo} set={setLo} step={0.02} min={X_MIN} max={X_MAX} />
            <NumberPill label="b" value={hi} set={setHi} step={0.02} min={X_MIN} max={X_MAX} />
          </div>
          <div class="tiles">
            <span class="tile">mean {attributedRead(moments)?.mean.toFixed(2) ?? "…"}</span>
            <span class="tile">sd {attributedRead(moments)?.sd.toFixed(2) ?? "…"}</span>
          </div>
        </div>
      </main>
    </div>
  );
}

export function mountScenery(host: HTMLElement): void {
  // The scenery styles in styles.ts scope under #wb-scenery; the shell only
  // provides #wb-app, so the mount claims the scenery id itself.
  host.id = "wb-scenery";
  // Arm automatic element → cell attribution BEFORE the synchronous render:
  // the curves / probability / moments cells (created at module load, above)
  // are already registered, and every attributedRead() below stamps its
  // rendering element as the tree is constructed. See aiui-viz/cell-attribution.
  enableCellAttribution();
  render(() => <App />, host);
}
