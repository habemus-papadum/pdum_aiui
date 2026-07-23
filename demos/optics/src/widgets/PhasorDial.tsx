/**
 * PhasorDial.tsx — arrows added tip-to-tail: the one picture that turns
 * "interference" from a word into a mechanism. Each contribution to the field
 * at a probe point is an arrow (length = amplitude, direction = phase);
 * the detector sees only the RESULTANT's length, squared. Aligned arrows =
 * bright; arrows curling into a spiral = dark. That's all interference is.
 *
 * The dial optionally spins the whole diagram slowly (the e^{-iωt} of a
 * monochromatic wave): the shape — and therefore the brightness — never
 * changes, which is exactly why only *relative* phases matter, and why a
 * detector integrating over time sees a steady value.
 */
import { createEffect, onCleanup } from "solid-js";
import { whileVisible } from "./anim";

export interface PhasorArrow {
  re: number;
  im: number;
  color?: string;
  label?: string;
}

export function PhasorDial(props: {
  arrows: PhasorArrow[];
  /** Diagram size in px (it renders square). Default 190. */
  size?: number;
  /** Spin the diagram at the wave's slow-motion rate. Default true. */
  spin?: boolean;
  /** Resultant arrow color. */
  resultantColor?: string;
  title?: string;
}) {
  const size = () => props.size ?? 190;

  const chain = () => {
    let x = 0;
    let y = 0;
    const pts = [{ x, y }];
    for (const a of props.arrows) {
      x += a.re;
      y += a.im;
      pts.push({ x, y });
    }
    let reach = Math.hypot(x, y);
    for (const p of pts) reach = Math.max(reach, Math.hypot(p.x, p.y));
    const total = props.arrows.reduce((acc, a) => acc + Math.hypot(a.re, a.im), 0);
    return { pts, sum: { x, y }, scale: reach > 0 ? 0.42 / Math.max(reach, total * 0.35) : 1 };
  };

  let spinGroup: SVGGElement | undefined;
  let stop: (() => void) | undefined;
  onCleanup(() => stop?.());
  // the rAF loop reads only this mirrored let — never a reactive prop
  let spinV = true;
  createEffect(
    () => props.spin !== false,
    (v) => {
      spinV = v;
    },
  );
  // observe the host div (IntersectionObserver on SVG internals is shaky);
  // the spin group's ref just records the node for the transform writes
  const host = (el: HTMLDivElement): void => {
    let angle = 0;
    let last = 0;
    stop = whileVisible(el, (t) => {
      if (!spinV) {
        last = t;
        return;
      }
      const dt = last ? (t - last) / 1000 : 0;
      last = t;
      angle = (angle - 42 * dt) % 360; // e^{-iωt}, slowed to visibility
      spinGroup?.setAttribute("transform", `rotate(${angle})`);
    });
  };
  const mount = (g: SVGGElement): void => {
    spinGroup = g;
  };

  const head = (x0: number, y0: number, x1: number, y1: number): string => {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const s = 0.018;
    return `M ${x1} ${y1} L ${x1 - s * (ux + 0.5 * uy)} ${y1 - s * (uy - 0.5 * ux)} L ${
      x1 - s * (ux - 0.5 * uy)
    } ${y1 - s * (uy + 0.5 * ux)} Z`;
  };

  return (
    <div ref={host} class="optix-phasor" style={{ width: `${size()}px` }}>
      <svg
        viewBox="-0.5 -0.5 1 1"
        width={size()}
        height={size()}
        role="img"
        aria-label={props.title ?? "phasor sum"}
      >
        <title>{props.title ?? "phasor sum"}</title>
        <circle cx={0} cy={0} r={0.44} class="optix-phasor-ring" />
        <line x1={-0.47} y1={0} x2={0.47} y2={0} class="optix-phasor-axis" />
        <line x1={0} y1={-0.47} x2={0} y2={0.47} class="optix-phasor-axis" />
        {/* y up: phase angles counter-clockwise, like every optics text */}
        <g transform="scale(1,-1)">
          <g ref={mount}>
            {(() => {
              const c = chain();
              const s = c.scale;
              return (
                <>
                  {props.arrows.map((a, i) => {
                    const p0 = c.pts[i];
                    const p1 = c.pts[i + 1];
                    const col = a.color ?? "#8f97a6";
                    return (
                      <>
                        <line
                          x1={p0.x * s}
                          y1={p0.y * s}
                          x2={p1.x * s}
                          y2={p1.y * s}
                          stroke={col}
                          stroke-width={0.012}
                          stroke-linecap="round"
                        />
                        <path d={head(p0.x * s, p0.y * s, p1.x * s, p1.y * s)} fill={col} />
                      </>
                    );
                  })}
                  <line
                    x1={0}
                    y1={0}
                    x2={c.sum.x * s}
                    y2={c.sum.y * s}
                    stroke={props.resultantColor ?? "#e6d24a"}
                    stroke-width={0.02}
                    stroke-linecap="round"
                  />
                  <path
                    d={head(0, 0, c.sum.x * s, c.sum.y * s)}
                    fill={props.resultantColor ?? "#e6d24a"}
                  />
                </>
              );
            })()}
          </g>
        </g>
      </svg>
      <div class="optix-phasor-readout">
        {(() => {
          const c = chain();
          const mag = Math.hypot(c.sum.x, c.sum.y);
          const max = props.arrows.reduce((acc, a) => acc + Math.hypot(a.re, a.im), 0);
          const frac = max > 0 ? (mag * mag) / (max * max) : 0;
          return (
            <>
              brightness |ΣE|² = <b>{(frac * 100).toFixed(0)}%</b> of aligned
            </>
          );
        })()}
      </div>
    </div>
  );
}
