/**
 * Oscilloscope.tsx — the trace and its knobs. A pure reader over the store
 * and the graph; the sample-count slider is the one control an agent that
 * has read graph.ts will reach for when asked why the line is jagged.
 */

import { TRACE_SECONDS } from "@habemus-papadum/aiui-oscillator";
import { CellView, ControlSlider } from "@habemus-papadum/aiui-viz";
import { graph } from "../model/graph";
import { osc, samples } from "../model/store";

export function tracePoints(trace: Float64Array, width: number, height: number): string {
  const pts: string[] = [];
  for (let i = 0; i < trace.length; i++) {
    const x = (i / Math.max(1, trace.length - 1)) * width;
    const y = height / 2 - (trace[i] / 2) * (height / 2);
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return pts.join(" ");
}

export function Oscilloscope() {
  return (
    <section class="scope-panel">
      <header class="scope-head">
        <h2>oscillator</h2>
        <CellView of={graph().pointsPerCycle} label="density">
          {(ppc) => (
            <span class="scope-density" data-bad={String(ppc() < 10)}>
              {ppc().toFixed(1)} points / cycle
            </span>
          )}
        </CellView>
        <button
          type="button"
          class="btn kick"
          title={osc.kick.description}
          onClick={() => osc.kick.run()}
        >
          kick
        </button>
      </header>
      <CellView of={graph().trace} label="sampling">
        {(trace) => (
          <svg class="scope-svg" viewBox="0 0 640 180" role="img" aria-label="oscillator trace">
            <line x1="0" y1="90" x2="640" y2="90" class="axis" />
            <polyline
              points={tracePoints(trace(), 640, 180)}
              fill="none"
              stroke="var(--accent)"
              stroke-width="1.5"
            />
            <text x="636" y="176" class="axis-label" text-anchor="end">
              {TRACE_SECONDS}s
            </text>
          </svg>
        )}
      </CellView>
      <div class="scope-controls">
        <ControlSlider of={osc.freq} label="frequency" format={(v) => `${v.toFixed(1)} Hz`} />
        <ControlSlider of={osc.damping} label="damping ζ" format={(v) => v.toFixed(2)} />
        <ControlSlider of={osc.amp} label="amplitude" format={(v) => v.toFixed(1)} />
        <ControlSlider of={samples} label="samples" format={(v) => `${v} pts`} />
      </div>
    </section>
  );
}
