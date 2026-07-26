/**
 * Sessions.tsx — the "five calendar days, seven actual hours" view.
 *
 * Two bars per session: wall-clock span, and the work inside it. The gap
 * between them is the point — a session that ran for a week was not a week of
 * work, and cost per calendar day is a meaningless statistic until you can see
 * that.
 *
 * The duty cycle depends entirely on where you put the idle threshold, so that
 * threshold is a control (store.ts) and this view recomputes live against it —
 * which is why `sessions` is a cell keyed on `idleGapMinutes` rather than a
 * column read straight out of the parquet.
 */

import { CellView, ControlSlider } from "@habemus-papadum/aiui-viz";
import { For, Show } from "solid-js";
import { graph, type SessionShape } from "../model/graph";
import { idleGapMinutes } from "../model/store";

const usd = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`);
const dur = (s: number) =>
  s >= 86400
    ? `${(s / 86400).toFixed(1)}d`
    : s >= 3600
      ? `${(s / 3600).toFixed(1)}h`
      : `${Math.round(s / 60)}m`;

function SessionRow(props: { s: SessionShape; maxSpan: number }) {
  const spanFrac = () => (props.maxSpan > 0 ? props.s.spanSeconds / props.maxSpan : 0);
  // The active bar is drawn as a fraction OF THE SPAN BAR, not of the axis, so
  // the eye reads duty cycle directly as "how much of this bar is filled".
  const activeFrac = () => Math.min(1, props.s.dutyCycle);
  return (
    <tr>
      <td class="lg-sess-name">
        <span class="lg-sess-project">{props.s.project}</span>
        <Show when={props.s.slug}>
          <span class="lg-sess-slug">{props.s.slug}</span>
        </Show>
      </td>
      <td class="lg-sess-bar">
        <div class="lg-span-track">
          <div class="lg-span-fill" style={{ width: `${spanFrac() * 100}%` }}>
            <div class="lg-active-fill" style={{ width: `${activeFrac() * 100}%` }} />
          </div>
        </div>
      </td>
      <td class="lg-num">{dur(props.s.spanSeconds)}</td>
      <td class="lg-num">{dur(props.s.activeSeconds)}</td>
      <td class={`lg-num lg-duty${props.s.dutyCycle < 0.15 ? " lg-duty-low" : ""}`}>
        {(props.s.dutyCycle * 100).toFixed(0)}%
      </td>
      <td class="lg-num">{props.s.nTurns}</td>
      <td class="lg-num">{props.s.nCompactions || ""}</td>
      <td class="lg-num">{usd(props.s.cost)}</td>
    </tr>
  );
}

export function Sessions() {
  return (
    <section class="lg-panel">
      <header class="lg-panel-head">
        <h2 class="lg-h2">sessions — elapsed vs worked</h2>
        <ControlSlider of={idleGapMinutes} label="idle gap" />
      </header>
      <p class="lg-note">
        The outer bar is wall-clock span; the filled part is time actually spent working, summing
        every inter-turn gap shorter than the idle threshold. Move the slider and watch the duty
        cycles move — where you draw that line is a judgement call, so it is yours to make.
      </p>
      <CellView of={graph().sessions}>
        {(rows) => {
          const top = rows().slice(0, 25);
          const maxSpan = Math.max(...top.map((r) => r.spanSeconds), 1);
          return (
            <div class="lg-table-scroll">
              <table class="lg-table">
                <thead>
                  <tr>
                    <th>session</th>
                    <th>span vs active</th>
                    <th class="lg-num">span</th>
                    <th class="lg-num">active</th>
                    <th class="lg-num">duty</th>
                    <th class="lg-num">turns</th>
                    <th class="lg-num" title="context compactions">
                      cmpct
                    </th>
                    <th class="lg-num">cost</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={top}>{(s) => <SessionRow s={s} maxSpan={maxSpan} />}</For>
                </tbody>
              </table>
            </div>
          );
        }}
      </CellView>
    </section>
  );
}
