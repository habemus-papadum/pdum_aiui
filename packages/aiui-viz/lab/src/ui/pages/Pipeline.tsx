/**
 * Pipeline.tsx — a build pipeline drawn by Mermaid and DRIVEN from the
 * drawing. The text comes from the pure model (`pipelineText`), so the
 * diagram's ids are the model's ids. Click a stage: it is selected and its
 * details open. Hover one: its edges light up. The run clock colors the
 * stages done / active / pending and a chip under each carries its rows or
 * progress — all marks, no re-render. Drag the `train` node sideways: it is
 * a knob on `epochs`. Toggle the evaluate stage: the TEXT changes, Mermaid
 * lays the diagram out again, and every mark comes back by id.
 */
import { TOKENS } from "@habemus-papadum/aiui-design";
import { ControlSlider, ControlToggle } from "@habemus-papadum/aiui-viz";
import { Mermaid, type MermaidHit, type MermaidMark } from "@habemus-papadum/aiui-viz/site/mermaid";
import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, Show } from "solid-js";
import { graph } from "../../model/graph";
import {
  edgesOf,
  fmtRows,
  neighbors,
  pipelineText,
  type StageState,
  type Status,
  stagesOf,
  totalCost,
} from "../../model/pipeline";
import { clock, epochs, running, select, selected, withEval } from "../../model/store";

const FILL: Record<Status, string | undefined> = {
  done: "var(--ok-wash)",
  active: "var(--accent-wash)",
  pending: undefined,
};
const STROKE: Record<Status, string | undefined> = {
  done: TOKENS.ok,
  active: TOKENS.accent,
  pending: undefined,
};

export function Pipeline(): JSX.Element {
  const [hover, setHover] = createSignal<MermaidHit | undefined>();
  const params = createMemo(() => ({ epochs: epochs.get(), withEval: withEval.get() }));
  // The diagram's STRUCTURE depends on one switch; the epochs change a cost,
  // not the drawing. Keying the text, stages and edges on the switch alone
  // keeps a knob drag from rebuilding every mark (and every chip) per pixel.
  const structure = createMemo(() => ({ epochs: 1, withEval: withEval.get() }));
  const text = createMemo(() => pipelineText(structure()));
  const stages = createMemo(() => stagesOf(structure()));
  const edges = createMemo(() => edgesOf(structure()));
  const states = (): Record<string, StageState> => graph().pipeline.latest() ?? {};

  // The stage whose edges light up: the hovered node, else the selected one.
  const focus = (): string | undefined => {
    const h = hover();
    return h?.kind === "node" ? h.id : selected.get();
  };
  const lit = createMemo(() => {
    const f = focus();
    if (f === undefined) return new Set<string>();
    const n = neighbors(structure(), f);
    return new Set([...n.in, ...n.out]);
  });

  // Statuses as one string: the marks rebuild when a stage CHANGES state,
  // not on every tenth of a second of the clock (the chips read the clock
  // themselves, as components).
  const statusKey = createMemo(() =>
    stages()
      .map((s) => states()[s.id]?.status ?? "pending")
      .join(","),
  );

  const Chip = (p: { id: string }): JSX.Element => {
    const st = () => states()[p.id];
    const cost = () =>
      st() === undefined ? 0 : (st() as StageState).end - (st() as StageState).start;
    return (
      <span class="mmd-lab-chip">
        <Show when={st()?.status === "done"}>
          <b>{fmtRows(st()?.rowsOut ?? 0)}</b> rows
        </Show>
        <Show when={st()?.status === "active"}>
          <b>{Math.round((st()?.progress ?? 0) * 100)}%</b>
        </Show>
        <Show when={st()?.status === "pending"}>
          <Show when={p.id === "train"} fallback={<>{cost().toFixed(0)} s</>}>
            <b>{epochs.get()} epochs</b> · {cost().toFixed(1)} s
          </Show>
        </Show>
      </span>
    );
  };

  // Node marks and edge marks in separate memos: a hover (which only recolors
  // edges) leaves the node mark objects — and so their chips — untouched.
  const nodeMarks = createMemo((): Record<string, MermaidMark> => {
    const statuses = statusKey().split(",") as Status[];
    const sel = selected.get();
    const m: Record<string, MermaidMark> = {};
    stages().forEach((s, i) => {
      const status = statuses[i] ?? "pending";
      m[s.id] = {
        fill: FILL[status],
        color: STROKE[status],
        active: sel === s.id,
        class: status === "active" ? "mmd-lab-running" : undefined,
        note: <Chip id={s.id} />,
        control: s.id === "train" ? epochs : undefined,
        span: 200,
      };
    });
    return m;
  });
  const edgeMarks = createMemo((): Record<string, MermaidMark> => {
    const statuses = statusKey().split(",") as Status[];
    const l = lit();
    const quiet = hover() === undefined;
    const m: Record<string, MermaidMark> = {};
    for (const e of edges()) {
      const from = stages().findIndex((s) => s.id === e.from);
      m[e.id] = {
        color: l.has(e.id) ? TOKENS.accent : undefined,
        active: l.has(e.id) && quiet,
        class: statuses[from] === "done" ? "mmd-lab-flowing" : undefined,
      };
    }
    return m;
  });
  const marks = createMemo(() => ({ ...nodeMarks(), ...edgeMarks() }));

  const onClick = (hit: MermaidHit): void => {
    if (hit.kind === "node") select(hit.id);
    else if (hit.kind === "edge") select(edges().find((e) => e.id === hit.id)?.to);
    else select(undefined);
  };

  const sel = () => {
    const id = selected.get();
    const stage = stages().find((s) => s.id === id);
    const st = id === undefined ? undefined : states()[id];
    return stage === undefined || st === undefined || id === undefined
      ? undefined
      : { id, stage, st };
  };

  return (
    <article class="lab-page">
      <header>
        <p class="eyebrow">pipeline</p>
        <h1>A diagram as a control surface</h1>
        <p class="lede">
          The flowchart is rendered from the model's text, so its ids are the model's ids. Click a
          stage to select it; hover one to light its edges; run the clock and watch the stages turn.
          Drag the <code>train</code> node sideways — it is a knob on the epochs. Toggle the
          evaluate stage and the text itself changes: Mermaid lays the diagram out again and every
          mark comes back by id.
        </p>
      </header>

      <div class="lab-toolbar">
        <ControlToggle of={running} label="run" />
        <ControlSlider
          of={clock}
          label="t"
          class="slider-compact"
          format={(v) => `${v.toFixed(1)} s`}
        />
        <ControlSlider of={epochs} label="epochs" class="slider-compact" />
        <ControlToggle of={withEval} label="evaluate stage" />
        <span class="small muted lab-aside">run length {totalCost(params()).toFixed(1)} s</span>
      </div>

      <Mermaid
        class="mmd-lab-diagram"
        text={text()}
        marks={marks()}
        onClick={onClick}
        onHover={setHover}
      />

      <div class="panel">
        <div class="panel-head">
          <h2>{sel()?.stage.label ?? "no stage selected"}</h2>
          <span class="small muted">
            {sel() === undefined
              ? "click a stage, or an edge to select its target"
              : `node ${sel()?.id} · ${neighbors(params(), sel()?.id ?? "").in.length} in, ${neighbors(params(), sel()?.id ?? "").out.length} out`}
          </span>
        </div>
        <Show when={sel()}>
          {(s) => (
            <dl class="mmd-lab-details">
              <div>
                <dt>status</dt>
                <dd>
                  <span class={`mmd-lab-status mmd-lab-status-${s().st.status}`}>
                    {s().st.status}
                  </span>
                </dd>
              </div>
              <div>
                <dt>window</dt>
                <dd>
                  {s().st.start.toFixed(1)} – {s().st.end.toFixed(1)} s
                </dd>
              </div>
              <div>
                <dt>progress</dt>
                <dd>{Math.round(s().st.progress * 100)}%</dd>
              </div>
              <div>
                <dt>rows in</dt>
                <dd>{s().st.rowsIn.toLocaleString()}</dd>
              </div>
              <div>
                <dt>rows out</dt>
                <dd>{s().st.rowsOut.toLocaleString()}</dd>
              </div>
              <div>
                <dt>edges</dt>
                <dd class="small">
                  {[...neighbors(params(), s().id).in, ...neighbors(params(), s().id).out].join(
                    ", ",
                  )}
                </dd>
              </div>
            </dl>
          )}
        </Show>
      </div>
    </article>
  );
}
