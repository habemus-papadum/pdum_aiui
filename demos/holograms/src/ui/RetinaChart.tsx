/**
 * RetinaChart.tsx — what the eye on the rail actually sees: retina intensity
 * against apparent position, with the designer's-equation ghosts as dashed
 * ticks. When the wave peaks land on the ticks, the paraxial predictions and
 * the honest reconstruction agree — the page's recurring move.
 */
import { plot } from "@habemus-papadum/aiui-journal";

const W = 640;
const H = 150;
const PAD = { l: 34, r: 10, t: 10, b: 24 };

export function RetinaChart(props: {
  xApparent: Float64Array;
  intensity: Float64Array;
  color: string;
  /** Dashed ticks: predicted apparent positions (µm) with labels. */
  ghosts?: { x: number; label?: string }[];
  eyeX?: number;
}) {
  const x0 = () => props.xApparent[0];
  const x1 = () => props.xApparent[props.xApparent.length - 1];
  const xOf = (x: number): number => PAD.l + ((x - x0()) / (x1() - x0())) * (W - PAD.l - PAD.r);

  const path = (): string => {
    let peak = 0;
    for (const v of props.intensity) peak = Math.max(peak, v);
    if (peak === 0) return "";
    let d = "";
    for (let i = 0; i < props.intensity.length; i++) {
      const x = xOf(props.xApparent[i]);
      const y = H - PAD.b - Math.sqrt(props.intensity[i] / peak) * (H - PAD.t - PAD.b);
      d += d === "" ? `M ${x} ${y}` : ` L ${x} ${y}`;
    }
    return d;
  };

  const ticks = (): number[] => {
    const out: number[] = [];
    const step = 100;
    for (let x = Math.ceil(x0() / step) * step; x <= x1(); x += step) out.push(x);
    return out;
  };

  return (
    <svg
      class="retina-chart"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="what the eye sees: retina intensity vs apparent position"
    >
      <title>retina intensity vs apparent position</title>
      <line x1={PAD.l} y1={H - PAD.b} x2={W - PAD.r} y2={H - PAD.b} stroke={plot().rule} />
      {ticks().map((x) => (
        <g>
          <line x1={xOf(x)} y1={H - PAD.b} x2={xOf(x)} y2={H - PAD.b + 4} stroke={plot().rule} />
          <text x={xOf(x)} y={H - 7} text-anchor="middle" class="chart-tick">
            {x}
          </text>
        </g>
      ))}
      {(props.ghosts ?? []).map((g) =>
        g.x >= x0() && g.x <= x1() ? (
          <g>
            <line
              x1={xOf(g.x)}
              y1={PAD.t}
              x2={xOf(g.x)}
              y2={H - PAD.b}
              stroke={plot().strong}
              stroke-dasharray="3 4"
              opacity={0.6}
            />
            <text x={xOf(g.x)} y={PAD.t + 8} text-anchor="middle" class="chart-mark-label">
              {g.label ?? ""}
            </text>
          </g>
        ) : null,
      )}
      <path d={path()} fill="none" stroke={props.color} stroke-width={1.6} />
      <text x={W - PAD.r} y={H - 7} text-anchor="end" class="chart-tick">
        apparent position (µm){props.eyeX !== undefined ? ` · eye at ${props.eyeX}` : ""}
      </text>
    </svg>
  );
}
