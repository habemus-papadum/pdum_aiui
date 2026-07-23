/**
 * SpectrumChart.tsx — reflectance vs wavelength for the thick film, with the
 * area under the curve painted in the actual colors: the peak IS the color
 * the hologram hands back out of white light.
 */
import { plot } from "@habemus-papadum/aiui-journal";
import { waveColorCss } from "@habemus-papadum/aiui-optics";
import { LAMBDA_BAND } from "../model/bench";

const W = 640;
const H = 180;
const PAD = { l: 40, r: 12, t: 12, b: 26 };

export function SpectrumChart(props: {
  lambdas: Float64Array;
  reflect: Float64Array;
  peakLambda: number;
}) {
  const xOf = (l: number): number =>
    PAD.l + ((l - LAMBDA_BAND[0]) / (LAMBDA_BAND[1] - LAMBDA_BAND[0])) * (W - PAD.l - PAD.r);
  const yOf = (r: number): number => H - PAD.b - r * (H - PAD.t - PAD.b);

  const areaPath = (): string => {
    let d = `M ${xOf(props.lambdas[0])} ${yOf(0)}`;
    for (let i = 0; i < props.lambdas.length; i++) {
      d += ` L ${xOf(props.lambdas[i])} ${yOf(props.reflect[i])}`;
    }
    d += ` L ${xOf(props.lambdas[props.lambdas.length - 1])} ${yOf(0)} Z`;
    return d;
  };

  const stops = () => {
    const out: { off: number; color: string }[] = [];
    for (let i = 0; i <= 24; i++) {
      const l = LAMBDA_BAND[0] + (i / 24) * (LAMBDA_BAND[1] - LAMBDA_BAND[0]);
      out.push({ off: (i / 24) * 100, color: waveColorCss(l, LAMBDA_BAND) });
    }
    return out;
  };

  return (
    <svg
      class="spectrum-chart"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="reflectance versus wavelength"
    >
      <title>reflectance vs wavelength</title>
      <defs>
        <linearGradient id="holo-spectrum" x1="0" y1="0" x2="1" y2="0">
          {stops().map((s) => (
            <stop offset={`${s.off}%`} stop-color={s.color} />
          ))}
        </linearGradient>
      </defs>
      {/* the white-light illumination band, faint */}
      <rect
        x={PAD.l}
        y={PAD.t}
        width={W - PAD.l - PAD.r}
        height={H - PAD.t - PAD.b}
        fill="url(#holo-spectrum)"
        opacity={0.09}
      />
      <line x1={PAD.l} y1={H - PAD.b} x2={W - PAD.r} y2={H - PAD.b} stroke={plot().rule} />
      {[5, 6, 7, 8, 9, 10, 11, 12, 13].map((l) => (
        <g>
          <line x1={xOf(l)} y1={H - PAD.b} x2={xOf(l)} y2={H - PAD.b + 4} stroke={plot().rule} />
          <text x={xOf(l)} y={H - 8} text-anchor="middle" class="chart-tick">
            {l}
          </text>
        </g>
      ))}
      <text x={W - PAD.r} y={H - 8} text-anchor="end" class="chart-tick">
        λ (µm)
      </text>
      {[0.5, 1].map((r) => (
        <g>
          <line x1={PAD.l - 4} y1={yOf(r)} x2={PAD.l} y2={yOf(r)} stroke={plot().rule} />
          <text x={PAD.l - 7} y={yOf(r) + 3} text-anchor="end" class="chart-tick">
            {r * 100}%
          </text>
        </g>
      ))}
      {/* what the film reflects, in its own colors */}
      <path d={areaPath()} fill="url(#holo-spectrum)" opacity={0.85} />
      <path d={areaPath()} fill="none" stroke={plot().strong} stroke-width={1} opacity={0.5} />
    </svg>
  );
}
