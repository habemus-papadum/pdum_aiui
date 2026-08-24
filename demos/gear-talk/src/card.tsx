/**
 * card.tsx — the landing-page card (aiui-viz's DemoCard): a blurb and a LIVE
 * preview. Self-contained: a slowly meshing pair drawn from demo-gears' PURE
 * geometry inside a little slide frame — no store, no graph, no cell — with
 * its own rAF cancelled on unmount.
 */
import type { DemoCard } from "@habemus-papadum/aiui-viz";
import { gearGeometry, meshGeometry, toPathD } from "@habemus-papadum/demo-gears/gear";
import { onCleanup } from "solid-js";

const STD = { module: 8, pressureAngle: 20, addendum: 1, dedendum: 1.25 };

function Preview() {
  const a = gearGeometry({ teeth: 13, ...STD });
  const b = gearGeometry({ teeth: 21, ...STD });
  const mesh = meshGeometry(a, b);

  const pad = STD.module * 1.6;
  const minX = -a.addendumRadius - pad;
  const maxX = mesh.center + b.addendumRadius + pad;
  const halfY = Math.max(a.addendumRadius, b.addendumRadius) + pad;

  let gA: SVGGElement | undefined;
  let gB: SVGGElement | undefined;
  let raf = 0;
  let angle = 0;
  let last = 0;
  const loop = (now: number): void => {
    raf = requestAnimationFrame(loop);
    const dt = last ? (now - last) / 1000 : 0;
    last = now;
    angle = (angle + 20 * dt) % 360;
    if (!gA || !gB) return;
    const thetaA = (angle * Math.PI) / 180;
    const thetaB = mesh.phaseB - (a.params.teeth / b.params.teeth) * thetaA;
    gA.setAttribute("transform", `rotate(${angle})`);
    gB.setAttribute("transform", `translate(${mesh.center} 0) rotate(${(thetaB * 180) / Math.PI})`);
  };
  raf = requestAnimationFrame(loop);
  onCleanup(() => cancelAnimationFrame(raf));

  return (
    <svg
      viewBox={`${minX} ${-halfY * 1.25} ${maxX - minX} ${2.5 * halfY}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="a slide with two meshing gears"
      style={{ width: "100%", height: "100%", display: "block", background: "#0b0d13" }}
    >
      <title>a slide with two meshing gears</title>
      {/* the "slide" frame the pair presents inside */}
      <rect
        x={minX + pad * 0.4}
        y={-halfY * 1.12}
        width={maxX - minX - pad * 0.8}
        height={2.24 * halfY}
        rx={6}
        fill="none"
        stroke="#2a3143"
        stroke-width={1.5}
      />
      <g transform="scale(1,-1)">
        <g
          ref={(el) => {
            gA = el;
          }}
        >
          <path d={toPathD(a.outline)} fill="none" stroke="#8ab4f8" stroke-width={1.6} />
        </g>
        <g
          ref={(el) => {
            gB = el;
          }}
        >
          <path d={toPathD(b.outline)} fill="none" stroke="#5f6f96" stroke-width={1.6} />
        </g>
      </g>
      {/* three dots: the deck's progress, as chrome */}
      <g fill="#3a4256">
        <circle cx={(minX + maxX) / 2 - 12} cy={halfY * 1.19} r={2.6} />
        <circle cx={(minX + maxX) / 2} cy={halfY * 1.19} r={2.6} fill="#8ab4f8" />
        <circle cx={(minX + maxX) / 2 + 12} cy={halfY * 1.19} r={2.6} />
      </g>
    </svg>
  );
}

export const card: DemoCard = {
  blurb:
    "The involute gear as a six-slide talk — the reference deck for the aiui slides framework: " +
    "one-step-per-gesture slides, a HUD overview with live previews, and Lens popups whose " +
    "sliders write the same graph the figures read.",
  Preview,
};
