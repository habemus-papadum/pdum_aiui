/**
 * substrate.tsx — specimens for shelf 1: a cell's states, a durable that
 * outlives the route, the declared control surface, the scope's qualified
 * names, and the page's tools registry.
 */
import { type Cell, ControlSlider, ensureAiuiGlobal } from "@habemus-papadum/aiui-viz";
import type { JSX } from "@solidjs/web";
import { createSignal, For, onCleanup, Show } from "solid-js";
import { graph } from "../../model/graph";
import {
  activations,
  appScope,
  breakSummary,
  damping,
  deactivations,
  frequency,
  randomize,
  shape,
  showEnvelope,
} from "../../model/store";

function StateChip(props: { name: string; cell: Cell<unknown> }): JSX.Element {
  const progress = (): string => {
    const p = props.cell.progress();
    return p === undefined || props.cell.state() === "ready" ? "" : ` · ${Math.round(p * 100)}%`;
  };
  return (
    <span class="cat-state" data-cell-state={props.cell.state()}>
      <code>{props.name}</code>
      <span class="cat-state-word">
        {props.cell.state()}
        {progress()}
      </span>
    </span>
  );
}

export function CellSpecimen(): JSX.Element {
  return (
    <>
      <div class="cat-row">
        <ControlSlider
          of={frequency}
          label="frequency"
          class="slider-compact"
          format={(v) => v.toFixed(1)}
        />
        <StateChip name="samples" cell={graph().samples} />
        <StateChip name="summary" cell={graph().summary} />
      </div>
      <p class="cat-note">
        Two cells over this page's wave. <code>samples</code> is synchronous and settles the moment
        the slider moves; <code>summary</code> takes four steps with progress, so its state runs
        pending → refreshing → ready while the last value is kept. Each state word is the cell's{" "}
        <code>state()</code>, read live.
      </p>
    </>
  );
}

export function DurableSpecimen(): JSX.Element {
  return (
    <p class="cat-note cat-note-lead">
      This page has been activated <b class="numeric">{activations.get()}</b>{" "}
      {activations.get() === 1 ? "time" : "times"} and parked{" "}
      <b class="numeric">{deactivations.get()}</b> this session. The counters are{" "}
      <code>durableSignal</code>s in the page's scope: in the gallery, open another notebook and
      come back — the components were disposed and remounted and the cell graph rebuilt, but the
      numbers (and the wave's controls) are the ones you left. A hot edit does the same.
    </p>
  );
}

export function ControlSpecimen(): JSX.Element {
  const controls = [frequency, damping, shape, showEnvelope, breakSummary];
  const bounds = (c: (typeof controls)[number]): string => {
    const m = c.meta as { min?: number; max?: number; step?: number; options?: readonly unknown[] };
    if (m.options) return m.options.join(" | ");
    if (m.min !== undefined && m.max !== undefined) return `${m.min} – ${m.max}, step ${m.step}`;
    return typeof c.get() === "boolean" ? "true | false" : "";
  };
  return (
    <>
      <div class="cat-table">
        <table class="cat-surface">
          <thead>
            <tr>
              <th>declared</th>
              <th>value</th>
              <th>bounds</th>
              <th>description (from the doc comment)</th>
            </tr>
          </thead>
          <tbody>
            <For each={controls}>
              {(c) => (
                <tr>
                  <td>
                    <code>{c.name}</code>
                  </td>
                  <td class="numeric">{String(c.get())}</td>
                  <td class="numeric">{bounds(c)}</td>
                  <td>{c.description}</td>
                </tr>
              )}
            </For>
            <tr>
              <td>
                <code>{randomize.name}</code> <span class="cat-kind">action</span>
              </td>
              <td>
                <button type="button" class="btn btn-outline" onClick={() => randomize.run()}>
                  run
                </button>
              </td>
              <td />
              <td>{randomize.description}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="cat-note">
        Declaring is exposing: every row is a target of the <code>set</code> tool, and the action is
        the tool <code>{randomize.name}</code>. Names and descriptions were injected by the compiler
        from the bindings and doc comments in <code>store.ts</code>; nothing here was typed twice.
      </p>
    </>
  );
}

export function ScopeSpecimen(): JSX.Element {
  return (
    <p class="cat-note cat-note-lead">
      <code>scope("{appScope.name}")</code> qualifies everything this page declares: the controls{" "}
      <code>{frequency.name}</code> and <code>{damping.name}</code>, the cells{" "}
      <code>{appScope.qualify("samples")}</code> and <code>{appScope.qualify("summary")}</code>, the
      action <code>{randomize.name}</code>, the graph key, and the toolkit at{" "}
      <code>window.__{appScope.name}</code>. A second copy of this page under another scope could
      share this document without a collision — which is why the gallery can mount every notebook at
      once.
    </p>
  );
}

export function GlobalSpecimen(): JSX.Element {
  const registry = ensureAiuiGlobal()?.tools;
  const [tick, setTick] = createSignal(0);
  const off = registry?.onChange(() => setTick((t) => t + 1));
  onCleanup(() => off?.());
  const namespaces = () => {
    tick();
    return registry?.list() ?? [];
  };
  const total = () => namespaces().reduce((n, ns) => n + ns.tools.length, 0);
  return (
    <p class="cat-note cat-note-lead">
      <code>window.__AIUI__.tools</code> holds <b class="numeric">{total()}</b> tools in{" "}
      <b class="numeric">{namespaces().length}</b>{" "}
      {namespaces().length === 1 ? "namespace" : "namespaces"} right now:{" "}
      <For each={namespaces()}>
        {(ns, i) => (
          <>
            <Show when={i() > 0}>, </Show>
            <code>{ns.ns}</code>
            <span class="muted">
              {" "}
              ({ns.tools.length}
              {ns.active ? "" : ", parked"})
            </span>
          </>
        )}
      </For>
      . Every voice session and external host reads this one registry; a parked namespace is a
      notebook you left.
    </p>
  );
}
