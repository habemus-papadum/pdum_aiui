/**
 * card.tsx — the landing-page card (see aiui-viz's DemoCard): a blurb and a
 * LIVE preview. Self-contained: two meshing involute gears rotating, built with
 * the demo's OWN pure geometry (`gear.ts`) — no store, no graph, no cell. Gear
 * B is locked to gear A by the ratio and phase, so the teeth stay engaged, and
 * the line of action is drawn as the fixed contact normal.
 */
import type { DemoCard } from "@habemus-papadum/aiui-viz";
import { onCleanup } from "solid-js";
import { gearGeometry, meshGeometry, toPathD } from "./model/gear";

const COMMON = { module: 8, pressureAngle: 20, addendum: 1, dedendum: 1.25 };

function Preview() {
  const a = gearGeometry({ teeth: 12, ...COMMON });
  const b = gearGeometry({ teeth: 18, ...COMMON });
  const mesh = meshGeometry(a, b);

  const pad = a.params.module * 1.2;
  const minX = -a.addendumRadius - pad;
  const maxX = mesh.center + b.addendumRadius + pad;
  const halfY = Math.max(a.addendumRadius, b.addendumRadius) + pad;
  const viewBox = `${minX} ${-halfY} ${maxX - minX} ${2 * halfY}`;
  const sw = a.params.module * 0.06;

  let gA: SVGGElement | undefined;
  let gB: SVGGElement | undefined;
  let raf = 0;
  let angle = 0;
  let last = 0;
  const loop = (now: number): void => {
    raf = requestAnimationFrame(loop);
    const dt = last ? (now - last) / 1000 : 0;
    last = now;
    angle = (angle + 26 * dt) % 360;
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
      viewBox={viewBox}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Two meshing involute gears"
      style={{ width: "100%", height: "100%", display: "block", background: "#0b0d13" }}
    >
      <title>Two meshing involute gears</title>
      <g transform="scale(1,-1)">
        <line
          x1={0}
          y1={0}
          x2={mesh.center}
          y2={0}
          stroke="#3a4256"
          stroke-width={sw}
          stroke-dasharray="0.6 1.2"
        />
        <line
          x1={mesh.loaStart.x}
          y1={mesh.loaStart.y}
          x2={mesh.loaEnd.x}
          y2={mesh.loaEnd.y}
          stroke="#e6d24a"
          stroke-width={sw}
          stroke-linecap="round"
          opacity="0.85"
        />
        <g ref={gA}>
          <path
            d={toPathD(a.outline)}
            fill="rgba(122,162,247,0.14)"
            stroke="#7aa2f7"
            stroke-width={sw}
            stroke-linejoin="round"
          />
          <circle
            cx={0}
            cy={0}
            r={a.params.module * 0.5}
            fill="#0b0d13"
            stroke="#7aa2f7"
            stroke-width="0.4"
          />
        </g>
        <g ref={gB}>
          <path
            d={toPathD(b.outline)}
            fill="rgba(240,163,94,0.14)"
            stroke="#f0a35e"
            stroke-width={sw}
            stroke-linejoin="round"
          />
          <circle
            cx={0}
            cy={0}
            r={b.params.module * 0.5}
            fill="#0b0d13"
            stroke="#f0a35e"
            stroke-width="0.4"
          />
        </g>
      </g>
    </svg>
  );
}

export const card: DemoCard = {
  blurb:
    "Two involute spur gears in kinematic mesh: the contact point rides a fixed line of action while the teeth stay engaged at every angle. Scrub the drive, then inspect a single tooth.",
  Preview,
};
