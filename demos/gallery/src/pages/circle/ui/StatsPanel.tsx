/**
 * StatsPanel.tsx — the readout (playbook layer 3). A score gauge over a column
 * of measured statistics, rendered from the `stats` cell through CellView. When
 * the cell is `null` (no stroke measured yet) it shows a prompt; otherwise the
 * numbers, which update live while a stroke is drawn and freeze when it settles.
 */

import { CellView } from "@habemus-papadum/aiui-viz";
import type { JSX } from "@solidjs/web";
import { Show } from "@solidjs/web";
import type { CircleStats } from "../model/circle";
import { graph } from "../model/graph";
import { turnCount, turnPhase } from "../model/store";
import { asPct, round0, round1, round2, scoreColor, verdict } from "./format";
import { Sparkline } from "./Sparkline";

function TurnPill(): JSX.Element {
  const drawing = () => turnPhase.get() === "drawing";
  const label = () => (turnPhase.get() === "idle" ? "ready" : `turn ${turnCount.get()}`);
  return <span class={drawing() ? "turn-pill live" : "turn-pill"}>{label()}</span>;
}

function Gauge(props: { score: number }): JSX.Element {
  const R = 32;
  const C = 2 * Math.PI * R;
  const dash = () => (Math.max(0, Math.min(100, props.score)) / 100) * C;
  return (
    <div class="gauge">
      <svg width="80" height="80" viewBox="0 0 80 80" role="img">
        <title>Circle score gauge</title>
        <circle
          cx="40"
          cy="40"
          r={R}
          fill="none"
          stroke="rgba(255,255,255,0.08)"
          stroke-width="7"
        />
        <circle
          cx="40"
          cy="40"
          r={R}
          fill="none"
          stroke={scoreColor(props.score)}
          stroke-width="7"
          stroke-linecap="round"
          stroke-dasharray={`${dash()} ${C}`}
          transform="rotate(-90 40 40)"
        />
      </svg>
      <div>
        <div class="gauge-num" style={{ color: scoreColor(props.score) }}>
          {round0(props.score)}
        </div>
        <div class="gauge-label">{verdict(props.score)}</div>
      </div>
    </div>
  );
}

function Row(props: { k: string; v: JSX.Element }): JSX.Element {
  return (
    <div class="stat-row">
      <span class="k">{props.k}</span>
      <span class="v">{props.v}</span>
    </div>
  );
}

function Body(props: { s: CircleStats }): JSX.Element {
  const s = () => props.s;
  return (
    <>
      <Gauge score={s().score} />
      <div class="stat-rows">
        <Row
          k="Roundness"
          v={
            <>
              {asPct(s().roundness)}
              <small>%</small>
            </>
          }
        />
        <Row
          k="Radius"
          v={
            <>
              {round0(s().radius)}
              <small>px</small>
            </>
          }
        />
        <Row
          k="Radial wobble"
          v={
            <>
              {round1(s().radialRms)}
              <small>px · {asPct(s().radialCv)}%</small>
            </>
          }
        />
        <Row k="Eccentricity" v={round2(s().eccentricity)} />
        <Row
          k="Axis ratio"
          v={
            <>
              {round2(s().axisRatio)}
              <small>· {round0(s().tiltDeg)}°</small>
            </>
          }
        />
        <Row
          k="Closure gap"
          v={
            <>
              {round0(s().closureGap)}
              <small>px · {asPct(s().closureRatio)}%</small>
            </>
          }
        />
        <Row
          k="Sweep"
          v={
            <>
              {round0(s().sweepDeg)}
              <small>°</small>
            </>
          }
        />
        <Row
          k="Area"
          v={
            <>
              {round0(s().area / 1000)}
              <small>k px²</small>
            </>
          }
        />
        <Row
          k="Path length"
          v={
            <>
              {round0(s().pathLength)}
              <small>px · {s().pointCount} pts</small>
            </>
          }
        />
      </div>
    </>
  );
}

function EmptyPrompt(): JSX.Element {
  return (
    <div class="readout-empty">
      <div class="big">Draw a circle</div>
      <div>Start a stroke anywhere. Stats appear as you draw and freeze when you lift.</div>
    </div>
  );
}

export function StatsPanel(): JSX.Element {
  return (
    <div class="readout">
      <div class="readout-head">
        <span>Circle score</span>
        <TurnPill />
      </div>
      <Sparkline />
      <CellView of={graph().stats}>
        {(value) => (
          <Show when={value()} fallback={<EmptyPrompt />}>
            {(s) => <Body s={s()} />}
          </Show>
        )}
      </CellView>
    </div>
  );
}
