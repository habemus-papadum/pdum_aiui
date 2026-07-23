/**
 * AngleChart.tsx — far-field power vs exit angle, hand-rolled SVG (the axes
 * are the lesson here: DIRECTIONS, not positions). Series are max-pooled into
 * pixel buckets so order needles survive decimation, and power is γ-stretched
 * (p^0.4) so sidelobes stay legible next to needles. Vertical marks carry the
 * grating-equation predictions — the chart shows the wave engine and the
 * one-line design rule agreeing.
 */
import { plot } from "@habemus-papadum/aiui-journal";

export interface AngleSeries {
  sin: Float64Array;
  power: Float64Array;
  color: string;
  label?: string;
}

const W = 640;
const H = 170;
const PAD = { l: 34, r: 10, t: 8, b: 26 };

export function AngleChart(props: {
  series: AngleSeries[];
  marks?: { sin: number; color?: string; label?: string }[];
  /** Angular half-range, as sinθ. Default 0.7 (±44°). */
  sinMax?: number;
}) {
  const sinMax = () => props.sinMax ?? 0.7;
  const degMax = () => (Math.asin(sinMax()) * 180) / Math.PI;
  const xOf = (deg: number): number =>
    PAD.l + ((deg + degMax()) / (2 * degMax())) * (W - PAD.l - PAD.r);
  const yOf = (p: number): number => H - PAD.b - p ** 0.4 * (H - PAD.t - PAD.b);

  const path = (s: AngleSeries): string => {
    const buckets = new Float64Array(W - PAD.l - PAD.r).fill(-1);
    for (let i = 0; i < s.sin.length; i++) {
      const deg = (Math.asin(Math.max(-1, Math.min(1, s.sin[i]))) * 180) / Math.PI;
      if (Math.abs(deg) > degMax()) continue;
      const b = Math.min(buckets.length - 1, Math.max(0, Math.floor(xOf(deg) - PAD.l)));
      if (s.power[i] > buckets[b]) buckets[b] = s.power[i];
    }
    let d = "";
    for (let b = 0; b < buckets.length; b++) {
      if (buckets[b] < 0) continue;
      const x = PAD.l + b + 0.5;
      const y = yOf(Math.min(1, buckets[b]));
      d += d === "" ? `M ${x} ${y}` : ` L ${x} ${y}`;
    }
    return d;
  };

  const ticks = () => {
    const out: number[] = [];
    const stepDeg = degMax() > 30 ? 15 : 10;
    for (let d = 0; d <= degMax(); d += stepDeg) {
      out.push(d);
      if (d > 0) out.push(-d);
    }
    return out.sort((a, b) => a - b);
  };

  return (
    <svg
      class="angle-chart"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="far-field power versus exit angle"
    >
      <title>far-field power vs exit angle</title>
      {/* axis */}
      <line x1={PAD.l} y1={H - PAD.b} x2={W - PAD.r} y2={H - PAD.b} stroke={plot().rule} />
      {ticks().map((d) => (
        <g>
          <line x1={xOf(d)} y1={H - PAD.b} x2={xOf(d)} y2={H - PAD.b + 4} stroke={plot().rule} />
          <text x={xOf(d)} y={H - 8} text-anchor="middle" class="chart-tick">
            {d}°
          </text>
        </g>
      ))}
      <text
        x={12}
        y={(H - PAD.b) / 2}
        class="chart-tick"
        transform={`rotate(-90 12 ${(H - PAD.b) / 2})`}
        text-anchor="middle"
      >
        power
      </text>
      {/* grating-equation marks */}
      {(props.marks ?? []).map((m) =>
        Math.abs(m.sin) <= sinMax() ? (
          <g>
            <line
              x1={xOf((Math.asin(m.sin) * 180) / Math.PI)}
              y1={PAD.t}
              x2={xOf((Math.asin(m.sin) * 180) / Math.PI)}
              y2={H - PAD.b}
              stroke={m.color ?? plot().strong}
              stroke-dasharray="3 4"
              opacity={0.55}
            />
            <text
              x={xOf((Math.asin(m.sin) * 180) / Math.PI)}
              y={PAD.t + 9}
              text-anchor="middle"
              class="chart-mark-label"
            >
              {m.label ?? ""}
            </text>
          </g>
        ) : null,
      )}
      {/* series */}
      {props.series.map((s) => (
        <path d={path(s)} fill="none" stroke={s.color} stroke-width={1.4} />
      ))}
    </svg>
  );
}
