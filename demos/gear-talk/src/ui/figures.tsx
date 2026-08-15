/**
 * figures.tsx — the talk's SVG vocabulary, all pure readers over demo-gears
 * geometry values (no cells, no controls — the SLIDES read the graph and pass
 * plain data down, so these also serve previews and lens bodies unchanged).
 *
 * Conventions from the gears notebook: geometry lives in a y-up local frame
 * (a tooth centred on +x), so scenes render inside a `scale(1,-1)` group;
 * gear B sits at (center, 0) with θ_B = phaseB − (z_A/z_B)·θ_A.
 */
import {
  contactPoints,
  type GearGeometry,
  type MeshGeometry,
  toPathD,
} from "@habemus-papadum/demo-gears/gear";
import type { JSX } from "@solidjs/web";

/** A meshing pair, optionally with the line of action and live contacts. */
export function MeshSvg(props: {
  a: GearGeometry;
  b: GearGeometry;
  mesh: MeshGeometry;
  /** Gear A's rotation, radians. */
  thetaA: number;
  showLoa?: boolean;
  showContacts?: boolean;
  class?: string;
  label: string;
}): JSX.Element {
  const view = () => {
    const pad = props.a.params.module * 1.6;
    const minX = -props.a.addendumRadius - pad;
    const maxX = props.mesh.center + props.b.addendumRadius + pad;
    const halfY = Math.max(props.a.addendumRadius, props.b.addendumRadius) + pad;
    return `${minX} ${-halfY} ${maxX - minX} ${2 * halfY}`;
  };
  const degA = () => (props.thetaA * 180) / Math.PI;
  const degB = () => {
    const thetaB = props.mesh.phaseB - (props.a.params.teeth / props.b.params.teeth) * props.thetaA;
    return (thetaB * 180) / Math.PI;
  };
  const contacts = () =>
    props.showContacts === true ? contactPoints(props.a, props.mesh, props.thetaA) : [];
  return (
    <svg
      viewBox={view()}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={props.label}
      class={props.class}
    >
      <title>{props.label}</title>
      <g transform="scale(1,-1)">
        <g transform={`rotate(${degA()})`}>
          <path class="fig-gear" d={toPathD(props.a.outline)} />
        </g>
        <g transform={`translate(${props.mesh.center} 0) rotate(${degB()})`}>
          <path class="fig-gear fig-gear-b" d={toPathD(props.b.outline)} />
        </g>
        {props.showLoa === true && (
          <>
            <line
              class="fig-loa"
              x1={props.mesh.loaStart.x}
              y1={props.mesh.loaStart.y}
              x2={props.mesh.loaEnd.x}
              y2={props.mesh.loaEnd.y}
            />
            <circle
              class="fig-pitch-pt"
              cx={props.mesh.pitchPoint.x}
              cy={props.mesh.pitchPoint.y}
              r={props.a.params.module * 0.28}
            />
          </>
        )}
        {contacts().map((p) => (
          <circle class="fig-contact" cx={p.x} cy={p.y} r={props.a.params.module * 0.22} />
        ))}
      </g>
    </svg>
  );
}

/** One gear with its four construction circles (anatomy slide + lenses). */
export function AnatomySvg(props: {
  gear: GearGeometry;
  /** Zoom onto the tooth at angle 0 instead of the whole wheel. */
  zoom?: boolean;
  class?: string;
  label: string;
}): JSX.Element {
  const view = () => {
    const g = props.gear;
    if (props.zoom === true) {
      const m = g.params.module;
      const w = g.addendumRadius - g.rootRadius + 3.4 * m;
      return `${g.rootRadius - 1.7 * m} ${-w * 0.62} ${w} ${w * 1.24}`;
    }
    const r = g.addendumRadius * 1.12;
    return `${-r} ${-r} ${2 * r} ${2 * r}`;
  };
  return (
    <svg
      viewBox={view()}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={props.label}
      class={props.class}
    >
      <title>{props.label}</title>
      <g transform="scale(1,-1)">
        <path class="fig-gear" d={toPathD(props.gear.outline)} />
        <circle class="fig-circle fig-pitch" r={props.gear.pitchRadius} />
        <circle class="fig-circle fig-base" r={props.gear.baseRadius} />
        <circle class="fig-circle fig-tip" r={props.gear.addendumRadius} />
        <circle class="fig-circle fig-root" r={props.gear.rootRadius} />
      </g>
    </svg>
  );
}

/** The bare involute construction: a base circle, the unwinding string, and
 * the curve it draws — the lens preview's whole story in one glyph. */
export function InvoluteSvg(props: { class?: string; label: string }): JSX.Element {
  const rb = 40;
  const pts: string[] = [];
  for (let t = 0; t <= 1.9; t += 0.05) {
    const x = rb * (Math.cos(t) + t * Math.sin(t));
    const y = rb * (Math.sin(t) - t * Math.cos(t));
    pts.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  const t0 = 1.25; // the tangent "string", drawn taut at one instant
  const onCircle = { x: rb * Math.cos(t0), y: rb * Math.sin(t0) };
  const onCurve = {
    x: rb * (Math.cos(t0) + t0 * Math.sin(t0)),
    y: rb * (Math.sin(t0) - t0 * Math.cos(t0)),
  };
  return (
    <svg
      viewBox="-55 -100 190 160"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={props.label}
      class={props.class}
    >
      <title>{props.label}</title>
      <g transform="scale(1,-1)">
        <circle class="fig-circle fig-base" r={rb} />
        <polyline class="fig-involute" points={pts.join(" ")} fill="none" />
        <line class="fig-string" x1={onCircle.x} y1={onCircle.y} x2={onCurve.x} y2={onCurve.y} />
        <circle class="fig-contact" cx={onCurve.x} cy={onCurve.y} r={3} />
      </g>
    </svg>
  );
}
