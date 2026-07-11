/**
 * Oscilloscope.tsx — one instance's panel (playbook layer 3): the trace, its
 * controls, and its kick button. A pure reader over ONE slice instance — the
 * component takes the store + its trace cell as props, so the same component
 * serves both instances (component reuse mirroring slice reuse).
 */
import type { OscillatorStore } from "@habemus-papadum/aiui-oscillator";
import { TRACE_SECONDS } from "@habemus-papadum/aiui-oscillator";
import { type Cell, CellView, ControlSlider } from "@habemus-papadum/aiui-viz";

/** Map a trace to an SVG polyline (x: time, y: displacement in [-2, 2]). */
export function tracePoints(trace: Float64Array, width: number, height: number): string {
  const pts: string[] = [];
  for (let i = 0; i < trace.length; i++) {
    const x = (i / (trace.length - 1)) * width;
    const y = height / 2 - (trace[i] / 2) * (height / 2);
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return pts.join(" ");
}

export function Oscilloscope(props: {
  title: string;
  accent: string;
  store: OscillatorStore;
  trace: Cell<Float64Array>;
}) {
  return (
    <section class="scope-panel">
      <header class="scope-head">
        <h2 style={{ color: props.accent }}>{props.title}</h2>
        <button
          type="button"
          class="kick"
          title={props.store.kick.description}
          onClick={() => props.store.kick.run()}
        >
          kick
        </button>
      </header>
      <CellView of={props.trace} label="sampling">
        {(trace) => (
          <svg class="scope-svg" viewBox="0 0 320 120" role="img" aria-label={props.title}>
            <line x1="0" y1="60" x2="320" y2="60" class="axis" />
            <polyline
              points={tracePoints(trace(), 320, 120)}
              fill="none"
              stroke={props.accent}
              stroke-width="1.5"
            />
            <text x="316" y="116" class="axis-label" text-anchor="end">
              {TRACE_SECONDS}s
            </text>
          </svg>
        )}
      </CellView>
      <div class="scope-controls">
        <ControlSlider
          of={props.store.freq}
          label="frequency"
          format={(v) => `${v.toFixed(1)} Hz`}
        />
        <ControlSlider of={props.store.damping} label="damping ζ" format={(v) => v.toFixed(2)} />
        <ControlSlider of={props.store.amp} label="amplitude" format={(v) => v.toFixed(1)} />
      </div>
    </section>
  );
}
