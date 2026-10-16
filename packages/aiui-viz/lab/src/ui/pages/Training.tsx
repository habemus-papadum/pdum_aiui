/**
 * Training.tsx — an RL objective whose terms breathe with a (fake) training
 * run, read through one LENS at a time:
 *
 *   magnitude  each term's ink follows its share of the loss; the note under
 *              it carries the name, a bar of the share, and the value.
 *   clipping   inside the surrogate: the two arguments of the min brighten by
 *              how often the batch picked each (notes below them), the two
 *              bounds of the clip by how often ratios fell past them (notes
 *              above). Running means ride the same bars as a tick.
 *   gradient   each term's ink follows its share of the gradient norm; the
 *              note under it is a signed bar of its alignment with the total
 *              update — right helps the step, left fights it.
 *
 * The equation's symbols ε, β, c_v, c_H are KNOBS: hover one for its value,
 * drag it to change it, and the run follows at once. Hover a term and its
 * series in the figure comes forward; hover a legend chip and the term lights
 * up — the link runs both ways.
 */
import { ControlSlider, ControlToggle } from "@habemus-papadum/aiui-viz";
import { PlotFigure } from "@habemus-papadum/aiui-viz/plot";
import { RichTeX, Term } from "@habemus-papadum/aiui-viz/site";
import type { JSX } from "@solidjs/web";
import { createSignal, For, Match, Show, Switch } from "solid-js";
import { graph, resetTraining } from "../../model/graph";
import { beta, ch, cv, epsilon, LENSES, type Lens, lens, playing, speed } from "../../model/store";
import { TERM_IDS, TERM_LABELS, type TermId } from "../../model/training";
import { HUE, HUE_CLIP, intensity } from "../hues";
import {
  alignmentPlotOptions,
  clipHistogramOptions,
  clipSeriesOptions,
  cosineMatrixOptions,
  gradientHeatmapOptions,
  trainingPlotOptions,
} from "../plots";

const LENS_LABEL: Record<Lens, string> = {
  magnitude: "magnitude",
  clipping: "clipping",
  gradient: "gradient",
};

const pct = (x: number): string => `${Math.round(x * 100)}%`;

export function Training(): JSX.Element {
  const [hover, setHover] = createSignal<TermId | undefined>();
  const L = () => lens.get();
  const latest = () => graph().latest.latest();
  const mag = (id: TermId) => latest()?.terms[id] ?? { value: 0, share: 0 };
  const grad = (id: TermId) => latest()?.grad.terms[id];
  const clip = () => latest()?.step.clip;
  const means = () => graph().clipSeries.latest()?.mean;
  const normShare = (id: TermId): number => {
    const g = latest()?.grad;
    if (g === undefined) return 0;
    const total = TERM_IDS.reduce((s, k) => s + g.terms[k].norm, 0);
    return total > 0 ? g.terms[id].norm / total : 0;
  };

  // ── notes ────────────────────────────────────────────────────────────────
  const Bar = (p: { frac: number; mean?: number; color: string }) => (
    <span class="rtx-lab-bar">
      <span class="rtx-lab-bar-fill" style={{ width: pct(p.frac), background: p.color }} />
      <Show when={p.mean !== undefined}>
        <i class="rtx-lab-bar-tick" style={{ left: pct(p.mean ?? 0) }} />
      </Show>
    </span>
  );

  const ShareNote = (p: { id: TermId }) => (
    <div class="rtx-lab-share" data-term={p.id}>
      <span class="rtx-lab-share-name">{TERM_LABELS[p.id]}</span>
      <Bar frac={mag(p.id).share} color={HUE[p.id]} />
      <span class="rtx-lab-share-value numeric">{mag(p.id).value.toFixed(3)}</span>
    </div>
  );

  /** A fraction of the batch, now and on average over the run. */
  const FracNote = (p: { label: string; now: () => number; mean: () => number; color: string }) => (
    <div class="rtx-lab-share rtx-lab-frac">
      <span class="rtx-lab-share-name">{p.label}</span>
      <Bar frac={p.now()} mean={p.mean()} color={p.color} />
      <span class="rtx-lab-share-value numeric">
        {pct(p.now())}
        <small class="muted"> · mean {pct(p.mean())}</small>
      </span>
    </div>
  );

  /** The term's alignment with the total update, signed, and its pull. */
  const GradNote = (p: { id: TermId }) => {
    const align = () => grad(p.id)?.align ?? 0;
    const norm = () => grad(p.id)?.norm ?? 0;
    return (
      <div class="rtx-lab-share" data-term={p.id}>
        <span class="rtx-lab-share-name">{TERM_LABELS[p.id]}</span>
        <span class="rtx-lab-bar rtx-lab-bar-signed">
          <i class="rtx-lab-bar-zero" />
          <span
            class="rtx-lab-bar-fill"
            style={{
              left: align() < 0 ? pct(0.5 + 0.5 * align()) : "50%",
              width: pct(0.5 * Math.abs(align())),
              background: HUE[p.id],
            }}
          />
        </span>
        <span class="rtx-lab-share-value numeric">
          cos {align().toFixed(2)}
          <small class="muted"> · ‖g‖ {norm().toFixed(2)}</small>
        </span>
      </div>
    );
  };

  // A note is present only when its lens is on: `note` is spread in, never
  // passed as undefined (a written `note` prop, even undefined, is a note).
  const noteFor = (id: TermId) => {
    const l = L();
    if (l === "clipping") return {};
    return {
      get note() {
        return l === "magnitude" ? <ShareNote id={id} /> : <GradNote id={id} />;
      },
    };
  };
  const clipNote = (label: string, now: () => number, mean: () => number, color: string) =>
    L() === "clipping"
      ? { note: <FracNote label={label} now={now} mean={mean} color={color} /> }
      : {};

  // ── ink ──────────────────────────────────────────────────────────────────
  const termInk = (id: TermId): string => {
    switch (L()) {
      case "magnitude":
        return intensity(HUE[id], mag(id).share);
      case "gradient":
        return intensity(HUE[id], normShare(id));
      default:
        return intensity(HUE[id], id === "policy" ? 1 : 0);
    }
  };
  /** Inside the surrogate: colored by the clipping lens, else inherited. */
  const innerInk = (hue: string, frac: () => number): string | undefined =>
    L() === "clipping" ? intensity(hue, frac()) : undefined;

  const term = (id: TermId, children: JSX.Element) => (
    <Term
      id={id}
      color={termInk(id)}
      active={hover() === id}
      onHover={(h) => setHover(h ? id : undefined)}
      {...noteFor(id)}
    >
      {children}
    </Term>
  );

  const picked = () => 1 - (clip()?.clipped ?? 0);
  const clipped = () => clip()?.clipped ?? 0;
  const below = () => clip()?.low ?? 0;
  const above = () => clip()?.high ?? 0;

  return (
    <article class="lab-page">
      <header>
        <p class="eyebrow">training</p>
        <h1>An objective that breathes</h1>
        <p class="lede">
          A PPO-style loss with a value head, an entropy bonus and a KL penalty. The run is a fake,
          deterministic one; what is real is the mapping. One lens at a time: how much each term
          weighs, what happens inside the clip, or how hard each term pulls on the step. The Greek
          letters are knobs — hover for the value, drag to change it, the run follows.
        </p>
      </header>

      <div class="lab-toolbar">
        <ControlToggle of={playing} label="run" />
        <ControlSlider of={speed} label="speed" class="slider-compact" />
        <span class="rtx-lab-segmented" data-control={lens.name} title={lens.description}>
          <For each={LENSES}>
            {(l) => (
              <button
                type="button"
                class="rtx-lab-seg"
                aria-pressed={L() === l ? "true" : "false"}
                onClick={() => lens.set(l)}
              >
                {LENS_LABEL[l]}
              </button>
            )}
          </For>
        </span>
        <button type="button" class="btn btn-outline" onClick={() => resetTraining.run?.()}>
          reset
        </button>
        <span class="lab-aside numeric">step {latest()?.step.step ?? 0}</span>
      </div>

      <RichTeX display class="rtx-lab-eq">
        {"L(\\theta) ="}
        {term("policy", [
          "-\\,\\mathbb{E}_t\\Big[\\min\\big(",
          <Term
            id="minA"
            color={innerInk(HUE_CLIP.unclipped, picked)}
            {...clipNote(
              "min takes r·Â",
              picked,
              () => 1 - (means()?.clipped ?? 0),
              HUE_CLIP.unclipped,
            )}
          >
            {"r_t(\\theta)\\,\\hat A_t"}
          </Term>,
          ",\\ ",
          <Term
            id="minB"
            color={innerInk(HUE_CLIP.clipped, clipped)}
            {...clipNote(
              "min takes clip·Â",
              clipped,
              () => means()?.clipped ?? 0,
              HUE_CLIP.clipped,
            )}
          >
            {"\\mathrm{clip}\\big(r_t(\\theta),\\,"}
            <Term
              id="lo"
              place="above"
              color={innerInk(HUE_CLIP.below, below)}
              {...clipNote("r below", below, () => means()?.low ?? 0, HUE_CLIP.below)}
            >
              {"1-"}
              <Term id="eps1" control={epsilon}>
                {"\\epsilon"}
              </Term>
            </Term>
            {",\\,"}
            <Term
              id="hi"
              place="above"
              color={innerInk(HUE_CLIP.above, above)}
              {...clipNote("r above", above, () => means()?.high ?? 0, HUE_CLIP.above)}
            >
              {"1+"}
              <Term id="eps2" control={epsilon}>
                {"\\epsilon"}
              </Term>
            </Term>
            {"\\big)\\,\\hat A_t"}
          </Term>,
          "\\big)\\Big]",
        ])}
        {"+"}
        {term("value", [
          <Term control={cv}>{"c_v"}</Term>,
          "\\,\\big(V_\\theta(s_t) - R_t\\big)^{2}",
        ])}
        {"-"}
        {term("entropy", [
          <Term control={ch}>{"c_H"}</Term>,
          "\\,\\mathcal{H}\\big[\\pi_\\theta(\\cdot \\mid s_t)\\big]",
        ])}
        {"+"}
        {term("kl", [
          <Term control={beta}>{"\\beta"}</Term>,
          "\\, D_{\\mathrm{KL}}\\big(\\pi_\\theta \\,\\|\\, \\pi_{\\mathrm{ref}}\\big)",
        ])}
      </RichTeX>

      <p class="small muted rtx-lab-coeffs">
        <Switch>
          <Match when={L() === "magnitude"}>
            Each term as it enters the loss, with its coefficient; the loss itself is{" "}
            <span class="numeric">{latest()?.step.loss.toFixed(3) ?? "…"}</span>.
          </Match>
          <Match when={L() === "clipping"}>
            A batch of 48 ratios per step. Below the min: how often each argument won. Above the
            clip: how often ratios fell past each bound. The min takes the clipped argument — and
            the sample drops out of the gradient — for a positive advantage above the band or a
            negative one below it: <span class="numeric">{pct(clipped())}</span> of this batch,{" "}
            <span class="numeric">{pct(means()?.clipped ?? 0)}</span> on average. Drag ε.
          </Match>
          <Match when={L() === "gradient"}>
            Synthetic: each term's gradient norm and its cosine against the total update, derived
            from a plausible pairwise geometry (the KL penalty opposes the policy gradient more as
            the policy drifts; clipped samples contribute no surrogate gradient). ‖g‖ ={" "}
            <span class="numeric">{latest()?.grad.total.toFixed(2) ?? "…"}</span>.
          </Match>
        </Switch>
      </p>

      <Switch>
        <Match when={L() === "magnitude"}>
          <div class="panel">
            <div class="panel-head">
              <h2>the run</h2>
              <Legend hover={hover()} onHover={setHover} />
            </div>
            <PlotFigure
              options={() => trainingPlotOptions(graph().lossSeries.latest() ?? [], hover())}
            />
          </div>
        </Match>
        <Match when={L() === "clipping"}>
          <div class="panel">
            <div class="panel-head">
              <h2>this batch</h2>
              <span class="small muted">
                shaded: the band [1−ε, 1+ε] · blue: the min took r·Â · brick: it took clip·Â
              </span>
            </div>
            <PlotFigure options={() => clipHistogramOptions(latest()?.step, epsilon.get())} />
          </div>
          <div class="panel">
            <div class="panel-head">
              <h2>over the run</h2>
              <span class="small muted">
                amber below the band, green above, grey inside · the line is the clip fraction
              </span>
            </div>
            <PlotFigure
              options={() => clipSeriesOptions(graph().clipSeries.latest()?.rows ?? [])}
            />
          </div>
        </Match>
        <Match when={L() === "gradient"}>
          <div class="panel">
            <div class="panel-head">
              <h2>where each term's gradient lands</h2>
              <Legend hover={hover()} onHover={setHover} />
            </div>
            <PlotFigure options={() => gradientHeatmapOptions(latest()?.grad, hover())} />
          </div>
          <div class="rtx-lab-figures-2">
            <div class="panel">
              <div class="panel-head">
                <h2>alignment over the run</h2>
                <span class="small muted">above zero helps the step; below fights it</span>
              </div>
              <PlotFigure
                options={() => alignmentPlotOptions(graph().gradSeries.latest() ?? [], hover())}
              />
            </div>
            <div class="panel">
              <div class="panel-head">
                <h2>who opposes whom</h2>
                <span class="small muted">pairwise cosines</span>
              </div>
              <PlotFigure options={() => cosineMatrixOptions(latest()?.grad)} />
            </div>
          </div>
        </Match>
      </Switch>
    </article>
  );
}

function Legend(p: { hover: TermId | undefined; onHover: (id: TermId | undefined) => void }) {
  return (
    <span class="legend">
      <For each={TERM_IDS}>
        {(id) => (
          <span
            class="rtx-lab-legend-item"
            data-active={String(p.hover === id)}
            onPointerEnter={() => p.onHover(id)}
            onPointerLeave={() => p.onHover(undefined)}
          >
            <i style={{ background: HUE[id] }} /> {TERM_LABELS[id]}
          </span>
        )}
      </For>
    </span>
  );
}
