/**
 * App.tsx — the reference sheet: every role, token, and component of the
 * design language on one page. Where a component can be live it is — the
 * control widgets and cell states are the real aiui-viz components over the
 * store and graph — and where a live one would need a backend (the dock row,
 * the log, the transcript) the specimen is static markup in the system's own
 * classes. TocRail builds its rail from the section[id] > h2 headings.
 */
import { CHART, TOKENS } from "@habemus-papadum/aiui-design";
import {
  CellText,
  CellView,
  ControlScrub,
  ControlSelect,
  ControlSlider,
  ControlToggle,
} from "@habemus-papadum/aiui-viz";
import { Lens, TeX, TocRail } from "@habemus-papadum/aiui-viz/site";
import { For } from "solid-js";
import { graph } from "../model/graph";
import { breakCatalog, feed, kill, nullcline, preset } from "../model/store";

function Hero() {
  return (
    <header class="hero">
      <p class="eyebrow">Design system · reference sheet</p>
      <p class="wordmark">aiui</p>
      <p class="display-sub">Notebooks &amp; Tools for Working Scientists</p>
      <p class="tagline">Cotton paper · slate ink · one accent</p>
      <p class="lede lede-masthead">
        A working paper, not a dashboard: type carries the hierarchy, the chrome stays monochrome,
        and the figures carry the color. This sheet shows every role the notebooks and the tool
        share.
      </p>
    </header>
  );
}

const SWATCHES: Array<{ token: string; value: string; note: string; outlined?: boolean }> = [
  { token: "--surface", value: TOKENS.surface, note: "the page · cotton paper", outlined: true },
  { token: "--surface-raised", value: TOKENS.surfaceRaised, note: "panels · 4%", outlined: true },
  { token: "--ink", value: TOKENS.ink, note: "text · slate" },
  { token: "--ink-muted", value: TOKENS.inkMuted, note: "secondary · 60%" },
  { token: "--muted", value: TOKENS.muted, note: "labels · 50%" },
  { token: "--hairline", value: TOKENS.hairline, note: "rules · 30%" },
  { token: "--ghost", value: TOKENS.ghost, note: "faint · 14%" },
  { token: "--accent", value: TOKENS.accent, note: "interaction only" },
  { token: "--ok", value: TOKENS.ok, note: "status · live, done" },
  { token: "--warn", value: TOKENS.warn, note: "status · pending, stale" },
  { token: "--alarm", value: TOKENS.alarm, note: "errors" },
  { token: "--plate", value: TOKENS.plate, note: "figure ground · constant" },
];

const SERIES: Array<{ name: string; value: string }> = [
  { name: "chart.blue", value: CHART.blue },
  { name: "chart.green", value: CHART.green },
  { name: "chart.amber", value: CHART.amber },
];

function Palette() {
  return (
    <section id="palette">
      <h2>Palette</h2>
      <p class="measure">
        Two anchors, paper and ink, and a ladder mixed between them. The accent appears only where
        interaction lives; the three status colors only on states. Data keeps its own validated
        palettes — the shared trio for charts on the paper is below.
      </p>
      <div class="swatch-grid">
        <For each={SWATCHES}>
          {(s) => (
            <div class="swatch">
              <span class="chip" style={{ background: s.value }} />
              <code>{s.token}</code>
              <small>{s.note}</small>
            </div>
          )}
        </For>
        <For each={SERIES}>
          {(s) => (
            <div class="swatch">
              <span class="chip" style={{ background: s.value }} />
              <code>{s.name}</code>
              <small>series · on a panel</small>
            </div>
          )}
        </For>
      </div>
    </section>
  );
}

function Typography() {
  return (
    <section id="typography">
      <h2>Typography &amp; Ligatures</h2>
      <div class="specimen">
        <span class="spec">heading · Cormorant 400</span>
        <h1>The Shape of the Estimate</h1>
      </div>
      <div class="specimen">
        <span class="spec">
          subhead · Fraunces, ligatures on, untracked (every h2 on this page)
        </span>
      </div>
      <div class="specimen">
        <span class="spec">title · Cormorant 700</span>
        <h3>Residuals under the alternate prior</h3>
      </div>
      <div class="specimen">
        <span class="spec">body · Cormorant 500, measure 36rem</span>
        <p class="measure">
          Prose is upright and set on a measure. Every numeral renders in Georgia on a tabular rail:
          the run cost $1,284.50 across 12 nodes from 09:15 to 17:40. Inline code keeps its own
          digits, <code>retries = 3, ttl = 900</code>, and a term that opens into detail is a lens.
          Links take <a href="#palette">the accent, and only links do</a>. Emphasis is{" "}
          <em>italic</em>, never color.
        </p>
      </div>
      <div class="specimen">
        <span class="spec">lede · Cormorant 400, ink-muted, measure 44rem — the standfirst</span>
        <p class="lede">
          The summary paragraph under a page heading belongs to this role, the reading face on its
          own measure. The tracked display voices carry one line at most; a page wanting both punch
          and explanation stacks a tagline over a lede.
        </p>
      </div>
      <div class="specimen">
        <span class="spec">eyebrow · Libre Franklin, tracked, uppercase</span>
        <h4>Methodology</h4>
      </div>
      <div class="specimen">
        <span class="spec">display-sub · the brand voice, a few words</span>
        <p class="display-sub">Diffusion, Dominoes &amp; Gratings</p>
      </div>
      <div class="specimen">
        <span class="spec">blockquote · italic, hairline rule</span>
        <blockquote class="measure">
          Differentiation comes from face, size, weight, and color — never decoration for its own
          sake.
        </blockquote>
      </div>
    </section>
  );
}

function Numerals() {
  return (
    <section id="numerals">
      <h2>Numerals</h2>
      <p class="measure">
        Every numeral is Georgia: in prose, in tables, in control readouts, in a chart's ticks. Code
        keeps its own digits: <code>retries = 3, ttl = 900</code>.
      </p>
      <table>
        <thead>
          <tr>
            <th>Run</th>
            <th>Nodes</th>
            <th>Wall clock</th>
            <th>Cost</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>baseline</td>
            <td class="numeric">12</td>
            <td class="numeric">2:41:07</td>
            <td class="numeric">$1,284.50</td>
          </tr>
          <tr>
            <td>pruned</td>
            <td class="numeric">8</td>
            <td class="numeric">1:12:33</td>
            <td class="numeric">$497.25</td>
          </tr>
          <tr>
            <td>distilled</td>
            <td class="numeric">1</td>
            <td class="numeric">0:09:58</td>
            <td class="numeric">$61.75</td>
          </tr>
        </tbody>
      </table>
      <figcaption>Georgia digits on the tabular rail; Franklin headers over a hairline.</figcaption>
    </section>
  );
}

/** A plate: a seeded blotchy raster, the kind a worker streams. */
function drawPlate(c: HTMLCanvasElement): void {
  const g = c.getContext("2d");
  if (g === null) return;
  const W = c.width;
  const H = c.height;
  const img = g.createImageData(W, H);
  let s = 7;
  const rnd = (): number => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const blobs = Array.from({ length: 48 }, () => [rnd() * W, rnd() * H, 14 + rnd() * 26]);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = 0;
      for (const [bx, by, r] of blobs) {
        const d = Math.hypot(x - bx, y - by);
        v += Math.exp(-(d * d) / (r * r));
      }
      v = Math.min(1, v);
      const i = (y * W + x) * 4;
      img.data[i] = 14 + 60 * v;
      img.data[i + 1] = 17 + 150 * v;
      img.data[i + 2] = 25 + 200 * v;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
}

/** Three series over a quiet grid, in the data palette. */
function SeriesChart() {
  const paths = [CHART.blue, CHART.green, CHART.amber].map((stroke, k) => {
    let d = "";
    for (let i = 0; i <= 28; i++) {
      const x = 30 + i * 10;
      const y = 125 - (k * 18 + 35 * (1 - Math.exp(-i / (6 + k * 4))) + 6 * Math.sin(i / 2 + k));
      d += `${i ? "L" : "M"}${x},${y.toFixed(1)}`;
    }
    return { d, stroke };
  });
  return (
    <svg viewBox="0 0 320 150" width="100%" aria-label="three series on a raised panel">
      <title>three series on a raised panel</title>
      <For each={[0, 1, 2, 3, 4]}>
        {(i) => (
          <line
            x1="30"
            x2="310"
            y1={10 + i * 30}
            y2={10 + i * 30}
            stroke="currentColor"
            stroke-opacity="0.12"
          />
        )}
      </For>
      <line x1="30" x2="30" y1="10" y2="130" stroke="currentColor" stroke-opacity="0.35" />
      <line x1="30" x2="310" y1="130" y2="130" stroke="currentColor" stroke-opacity="0.35" />
      <For each={paths}>
        {(p) => <path d={p.d} fill="none" stroke={p.stroke} stroke-width="1.75" />}
      </For>
      <For each={["0", "1k", "2k", "3k"]}>
        {(t, i) => (
          <text
            x={30 + i() * 93}
            y="145"
            font-size="9"
            fill="currentColor"
            fill-opacity="0.6"
            font-family="Digits, Libre Franklin, sans-serif"
          >
            {t}
          </text>
        )}
      </For>
    </svg>
  );
}

function Notebook() {
  return (
    <section id="notebook">
      <h2>A Notebook Section</h2>
      <p class="measure">
        The laboratory first: the plate is a dark figure framed by a hairline, the data panel sits
        on raised paper, and the controls read as instruments. Every widget here is the real
        component.
      </p>
      <div class="exhibit">
        <figure>
          <div class="plate">
            <canvas ref={drawPlate} width="640" height="400" />
          </div>
          <figcaption>
            Gray–Scott at f {feed.get().toFixed(3)}, k {kill.get().toFixed(3)} · a worker raster on
            the plate
          </figcaption>
        </figure>
        <div class="panel">
          <h3>Observables</h3>
          <SeriesChart />
          <div class="legend">
            <span>
              <i style={{ background: CHART.blue }} />
              spots
            </span>
            <span>
              <i style={{ background: CHART.green }} />
              stripes
            </span>
            <span>
              <i style={{ background: CHART.amber }} />
              frozen
            </span>
          </div>
          <div class="tiles" style={{ "margin-top": "var(--space-sm)" }}>
            <div class="tile">
              <div class="tile-value">
                <CellText of={graph().wavelength}>{(v) => v.toFixed(1)}</CellText>
              </div>
              <div class="tile-label">λ · cells</div>
            </div>
            <div class="tile">
              <div class="tile-value">
                <CellText of={graph().catalog}>{(v) => v.events.toLocaleString()}</CellText>
              </div>
              <div class="tile-label">events</div>
            </div>
            <div class="tile">
              <div class="tile-value">
                <CellText of={graph().catalog}>{(v) => v.largest.toFixed(1)}</CellText>
              </div>
              <div class="tile-label">largest M</div>
            </div>
          </div>
          <div class="control-row">
            <ControlSlider of={feed} label="feed" format={(v) => v.toFixed(3)} />
            <ControlSlider of={kill} label="kill" format={(v) => v.toFixed(3)} />
            <ControlToggle of={nullcline} label="show nullcline" />
            <ControlSelect of={preset} label="preset" />
          </div>
          <div class="controls-buttons">
            <button type="button" class="btn" onClick={() => feed.set(feed.initial)}>
              Regrow
            </button>
            <button type="button" class="btn btn-outline" onClick={() => kill.set(kill.initial)}>
              Reset
            </button>
            <button type="button" class="btn btn-outline" disabled>
              Export
            </button>
          </div>
        </div>
      </div>
      <p class="measure" style={{ "margin-top": "var(--space-md)" }}>
        A number in the prose is a scrub pill: hold the feed at{" "}
        <ControlScrub of={feed} label="f" format={(v) => v.toFixed(3)} /> and drag the kill toward{" "}
        <ControlScrub of={kill} format={(v) => v.toFixed(3)} />; the double dashed ring is the
        standing "this drags" affordance.
      </p>
      <h4 style={{ "margin-top": "var(--space-md)" }}>Experiments</h4>
      <ul class="experiments">
        <li>
          Raise <span class="ctrl">feed</span> past 0.05 and watch the spots join into stripes.
        </li>
        <li>
          Press <span class="ctrl">regrow</span> twice; the frozen fraction should return within 400
          steps.
        </li>
      </ul>
    </section>
  );
}

function CellStates() {
  return (
    <section id="cells">
      <h2>Cell States</h2>
      <p class="measure">
        The CellView contract, live: move a slider above and the wavelength cell re-runs with its
        last value dimmed under an accent stripe; flip the switch to break the catalog and see the
        error surface with its Retry.
      </p>
      <div class="specimen">
        <span class="spec">keep-latest · the previous value stays, dimmed, with the stripe</span>
        <div class="panel">
          <CellView of={graph().wavelength} keepLatest label="wavelength">
            {(v) => (
              <p>
                The pattern wavelength at this feed and kill is{" "}
                <b class="numeric">{v().toFixed(2)} cells</b>.
              </p>
            )}
          </CellView>
        </div>
      </div>
      <div class="specimen">
        <span class="spec">error · brick on a brick wash, hairline, an outline Retry</span>
        <div class="control-row">
          <ControlToggle of={breakCatalog} label="break the catalog fetch" />
        </div>
        <div class="panel">
          <CellView of={graph().catalog} label="catalog">
            {(v) => (
              <p>
                <b class="numeric">{v().events.toLocaleString()}</b> events since{" "}
                <span class="numeric">{v().sinceYear}</span>; the largest is M{" "}
                <span class="numeric">{v().largest.toFixed(1)}</span>.
              </p>
            )}
          </CellView>
        </div>
      </div>
    </section>
  );
}

function Chrome() {
  return (
    <section id="chrome">
      <h2>Site &amp; Tool Chrome</h2>
      <p class="measure">
        The same tokens on the sidebar, the voice dock, the tool log, and a transcript. Status is
        the only place a second color appears, and it is a dot, not a fill. (The live dock is in the
        corner of this page; this row is a static specimen.)
      </p>
      <div class="two">
        <nav class="nav-sample" aria-label="a sample sidebar">
          <h4>aiui · notebooks</h4>
          <a class="site-nav-item" href="#chrome">
            <span class="site-nav-item-name">Morphogen</span>
            <span class="site-nav-item-desc">reaction–diffusion lab</span>
          </a>
          <a class="site-nav-item site-nav-item-active" href="#chrome">
            <span class="site-nav-item-name">Seismos</span>
            <span class="site-nav-item-desc">a century of earthquakes</span>
          </a>
          <a class="site-nav-item" href="#chrome">
            <span class="site-nav-item-name">Aztec</span>
            <span class="site-nav-item-desc">streaming domino shuffling</span>
          </a>
        </nav>
        <div class="tool">
          <div class="dock-row">
            <button type="button" class="pill" aria-pressed="true">
              <i class="dot live" />
              oracle
            </button>
            <span class="pill">
              <i class="dot parked" />
              live · hosted
            </span>
            <span class="pill">
              <i class="dot busy" />
              claude
            </span>
            <span class="pill">
              <i class="dot err" />
              responses
            </span>
            <span class="pill">
              <i class="dot" />
              tools · 14
            </span>
          </div>
          <table class="log">
            <thead>
              <tr>
                <th>#</th>
                <th>caller</th>
                <th>tool</th>
                <th>ms</th>
                <th>ok</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>41</td>
                <td>oracle</td>
                <td>seismos.cross-filter</td>
                <td class="numeric">12</td>
                <td class="ok">ok</td>
              </tr>
              <tr>
                <td>42</td>
                <td>live:claude</td>
                <td>seismos.sql</td>
                <td class="numeric">318</td>
                <td class="ok">ok</td>
              </tr>
              <tr>
                <td>43</td>
                <td>channel</td>
                <td>seismos.schema</td>
                <td class="numeric">4</td>
                <td class="error">Binder Error: no table "quakes"</td>
              </tr>
            </tbody>
          </table>
          <div class="transcript">
            <span class="role">user</span>
            <span class="text">Show me only the deep ones after 1990.</span>
            <span class="role live">oracle</span>
            <span class="text">
              Filtering to depth over 300 km from 1990 on; 1,204 events remain.
            </span>
            <span class="role">tool</span>
            <span class="text mono">
              set-depth({"{"} range: [300, 700] {"}"}) → ok · 12 ms
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}

function WavelengthDetail() {
  return (
    <div>
      <p>
        The lens panel: a hairline surface on the page's own ground, square, unshadowed, its title
        in the label role. Anything can live here — a figure, a table, an instrument.
      </p>
      <TeX display tex="\lambda \approx 2\pi\sqrt{\frac{D_v}{k - f/2}}" />
    </div>
  );
}

function CodeMath() {
  return (
    <section id="code">
      <h2>Code, Math &amp; Lenses</h2>
      <pre>
        <code>{`const results = cell(query, async (q, ctx) => {
  const res = await fetch(\`/search?q=\${q}\`, { signal: ctx.signal });
  return await res.json(); // 1 -> 2 !== 3 (no code ligatures: what you read is what was typed)
});`}</code>
      </pre>
      <TeX
        display
        tex="\nabla \cdot u = 0, \qquad \frac{\partial u}{\partial t} + (u \cdot \nabla)\, u = -\nabla p + \nu \nabla^2 u"
      />
      <p class="measure">
        Inline math sits on the ink: <TeX tex="b = 0.87 \pm 0.002" />. A term that opens into detail
        is a{" "}
        <Lens label="the wavelength" detail={WavelengthDetail}>
          lens
        </Lens>
        : a dotted underline, accent under the pointer, a hairline panel on click.
      </p>
      <figcaption>
        KaTeX through the TeX component, with the data-tex stamp; the mono face routes no digits and
        ships no ligatures.
      </figcaption>
    </section>
  );
}

export function App() {
  return (
    <div class="styleguide app">
      <main class="app-main">
        <Hero />
        <Palette />
        <Typography />
        <Numerals />
        <Notebook />
        <CellStates />
        <Chrome />
        <CodeMath />
      </main>
      <TocRail />
    </div>
  );
}
