/**
 * views.tsx — specimens for shelves 2.4–2.7: a pad of ink, a lens, a Plot of
 * the wave, and the views for what an agent reads and writes — the tool log,
 * this page's own `report` through the JSON explorer, and its tool brief as a
 * model sees it.
 */
import { chart, plot, plotStyle } from "@habemus-papadum/aiui-design";
import { adopt, ControlSlider, ensureAiuiGlobal } from "@habemus-papadum/aiui-viz";
import { PlotFigure } from "@habemus-papadum/aiui-viz/plot";
import { Lens } from "@habemus-papadum/aiui-viz/site";
import { JsonView } from "@habemus-papadum/aiui-viz/site/json-view";
import { TextView } from "@habemus-papadum/aiui-viz/site/markdown";
import { toggleToolLog } from "@habemus-papadum/aiui-viz/site/tool-log";
import { type KitDoc, renderToolBrief } from "@habemus-papadum/aiui-viz/tool-brief";
import * as Plot from "@observablehq/plot";
import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, onCleanup, Show, untrack } from "solid-js";
import { graph } from "../../model/graph";
import { appScope, damping, frequency, shape, showEnvelope, strokes } from "../../model/store";
import { envelope, sampleWave } from "../../model/wave";

// ── 2.4 ink ──────────────────────────────────────────────────────────────────

export function InkSpecimen(): JSX.Element {
  // The surface is a module-level durable view (model/ink.ts); the component
  // adopts its canvas for the mount and hands it back on dispose.
  const padModule = import("../../model/ink");
  const adoptPad = adopt((host) => {
    let released = false;
    padModule.then(({ inkPad }) => {
      if (released) return;
      host.append(inkPad.canvas);
      inkPad.setActive(true);
      inkPad.refresh();
    });
    return () => {
      released = true;
      padModule.then(({ inkPad }) => {
        if (inkPad.canvas.parentElement !== host) return;
        inkPad.setActive(false);
        inkPad.canvas.remove();
      });
    };
  });
  return (
    <>
      <div class="cat-ink" ref={adoptPad} />
      <p class="cat-note">
        Draw. <b class="numeric">{strokes.get()}</b> {strokes.get() === 1 ? "stroke" : "strokes"} so
        far; the ink fades after a few seconds and the document expires it. The strokes are
        immutable records in a durable document (they survive a hot edit); this canvas is a view.
        What the ink <em>means</em> is the app's business — see the circle demo for a meter.
      </p>
    </>
  );
}

// ── 2.5 the lens ─────────────────────────────────────────────────────────────

/** The peek: a sparkline from the pure model, over the controls alone. */
function WavePeek(): JSX.Element {
  const d = (): string =>
    sampleWave({ frequency: frequency.get(), damping: damping.get(), shape: shape.get() }, 120, 2)
      .map((p, i) => `${i ? "L" : "M"}${(p.t * 100).toFixed(1)},${(22 - p.y * 18).toFixed(1)}`)
      .join("");
  return (
    <svg class="cat-peek" viewBox="0 0 200 44" width="200" height="44" aria-hidden="true">
      <line x1="0" x2="200" y1="22" y2="22" stroke="currentColor" stroke-opacity="0.2" />
      <path d={d()} fill="none" stroke={chart().blue} stroke-width="1.5" />
    </svg>
  );
}

/** The detail: the page's own figure and two of its controls, in the page's graph. */
function WaveDetail(): JSX.Element {
  return (
    <div class="cat-lens-detail">
      <WaveFigure height={200} />
      <div class="cat-row">
        <ControlSlider of={frequency} label="frequency" format={(v) => v.toFixed(1)} />
        <ControlSlider of={damping} label="damping" format={(v) => v.toFixed(2)} />
      </div>
    </div>
  );
}

export function LensSpecimen(): JSX.Element {
  return (
    <p class="cat-note cat-note-lead">
      A term that opens into detail is a{" "}
      <Lens label="the specimen wave" preview={WavePeek} detail={WaveDetail}>
        lens on the wave
      </Lens>
      : hover (or focus) for a peek built from the pure model, click for a panel that lives in this
      page's reactive graph — move its sliders and every specimen on the page follows.
    </p>
  );
}

// ── 2.6 the plot ─────────────────────────────────────────────────────────────

function WaveFigure(props: { height?: number }): JSX.Element {
  const options = createMemo<Plot.PlotOptions>(() => {
    const pts = graph().samples.latest() ?? [];
    const z = damping.get();
    const env = showEnvelope.get()
      ? pts.map((p) => ({ t: p.t, hi: envelope(z, p.t), lo: -envelope(z, p.t) }))
      : [];
    return {
      height: props.height ?? 180,
      marginLeft: 36,
      style: plotStyle(),
      x: { label: "t · s" },
      y: { label: null, domain: [-1.05, 1.05], grid: true },
      marks: [
        Plot.ruleY([0], { stroke: plot().rule }),
        Plot.lineY(env, { x: "t", y: "hi", stroke: chart().amber, strokeDasharray: "3,3" }),
        Plot.lineY(env, { x: "t", y: "lo", stroke: chart().amber, strokeDasharray: "3,3" }),
        Plot.lineY(pts, { x: "t", y: "y", stroke: chart().blue, strokeWidth: 1.75 }),
      ],
    };
  });
  return <PlotFigure options={options} />;
}

export function PlotSpecimen(): JSX.Element {
  return (
    <>
      <div class="panel">
        <WaveFigure />
      </div>
      <p class="cat-note">
        Observable Plot behind one seam: a reactive options memo in, a figure out, rebuilt on every
        change (cheap at this size). The style is the design system's <code>plotStyle()</code>; the
        series takes the chart palette, never the accent.
      </p>
    </>
  );
}

// ── 2.7 views for agent material ─────────────────────────────────────────────

export function ToolLogSpecimen(): JSX.Element {
  return (
    <>
      <div class="cat-row">
        <button type="button" class="btn btn-outline" onClick={() => toggleToolLog(true)}>
          open the tool log
        </button>
      </div>
      <p class="cat-note">
        The dock on this page hosts the log; <code>#aiui-tools</code> in the URL opens it on load.
        Three views: the calls (every <code>report</code> this page's own specimens make shows up
        there), the inventory, and the surface as rendered for a model.
      </p>
    </>
  );
}

export function JsonViewSpecimen(): JSX.Element {
  const registry = ensureAiuiGlobal()?.tools;
  const [result, setResult] = createSignal<unknown>();
  // The tool's `run` reads controls and cells synchronously: a one-shot
  // snapshot, not a subscription — so it runs untracked.
  const call = (): void => {
    untrack(() => {
      registry
        ?.call(appScope.name, "report", { format: "brief" }, { caller: "page" })
        .then(setResult, (e: unknown) => setResult({ error: String(e) }));
    });
  };
  call();
  return (
    <>
      <div class="cat-row">
        <button type="button" class="btn btn-outline" onClick={call}>
          call <code>report</code> again
        </button>
      </div>
      <div class="cat-json">
        {/* keyed: the explorer reads its value once, so a new result remounts it */}
        <Show when={result()} keyed fallback={<p class="muted">calling…</p>}>
          {(v) => <JsonView value={v} depth={2} />}
        </Show>
      </div>
      <p class="cat-note">
        The result of this page's <code>report</code> tool, called through the registry (so the call
        is in the tool log): the controls with values, the cells with states, the actions, and the
        live dependency edges. Small flat values stay inline; folds say what they hold.
      </p>
    </>
  );
}

export function TextViewSpecimen(): JSX.Element {
  const registry = ensureAiuiGlobal()?.tools;
  const [tick, setTick] = createSignal(0);
  const off = registry?.onChange(() => setTick((t) => t + 1));
  onCleanup(() => off?.());
  const brief = createMemo((): string => {
    tick();
    const kits: KitDoc[] = (registry?.list() ?? [])
      .filter((ns) => ns.ns === appScope.name)
      .map((ns) => ({
        ns: ns.ns,
        tools: ns.tools,
        ...(ns.brief !== undefined ? { brief: ns.brief } : {}),
      }));
    return renderToolBrief(kits);
  });
  return (
    <>
      <div class="cat-text">
        <TextView text={brief()} />
      </div>
      <p class="cat-note">
        This page's tool surface exactly as a model receives it — the <code>Tools:</code> section
        the oracle and the live delegators are given, rendered as Markdown with a toggle to the raw
        text. HTML in the text is escaped, never injected.
      </p>
    </>
  );
}
