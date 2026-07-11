/**
 * Lissajous.tsx — the composition made visible: the two instances' traces
 * plotted against each other. Reads the cross-slice `lissajous` cell — the
 * one that proves slices compose like any other cells.
 */
import { type Cell, CellView } from "@habemus-papadum/aiui-viz";

/** Interleaved [x0,y0,x1,y1,…] displacement pairs → an SVG polyline. */
export function lissajousPoints(pairs: Float64Array, size: number): string {
  const pts: string[] = [];
  for (let i = 0; i < pairs.length; i += 2) {
    const x = size / 2 + (pairs[i] / 2) * (size / 2);
    const y = size / 2 - (pairs[i + 1] / 2) * (size / 2);
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return pts.join(" ");
}

export function Lissajous(props: { figure: Cell<Float64Array> }) {
  return (
    <section class="scope-panel lissajous">
      <header class="scope-head">
        <h2>lissajous · left × right</h2>
      </header>
      <CellView of={props.figure} label="composing">
        {(pairs) => (
          <svg
            class="scope-svg square"
            viewBox="0 0 240 240"
            role="img"
            aria-label="Lissajous figure"
          >
            <line x1="0" y1="120" x2="240" y2="120" class="axis" />
            <line x1="120" y1="0" x2="120" y2="240" class="axis" />
            <polyline
              points={lissajousPoints(pairs(), 240)}
              fill="none"
              stroke="var(--accent, #b48ead)"
              stroke-width="1.5"
            />
          </svg>
        )}
      </CellView>
      <p class="hint">
        x is the <b class="left-accent">left</b> oscillator, y the <b class="right-accent">right</b>{" "}
        — set left to 1 Hz and right to 2 Hz for a figure-eight, then kick one of them.
      </p>
    </section>
  );
}
