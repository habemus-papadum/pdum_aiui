/**
 * GearMesh.tsx — Layer 3: the assembly view (an imperative rAF island).
 *
 * The gear outlines are declarative SVG paths derived from the `scene` cell.
 * Only two things move every frame, and they are driven imperatively (never
 * through signals, per the hot-loop rule): each gear's rotation transform, and
 * the contact point(s) sliding along the line of action. Gear B's angle is
 * locked to gear A's by the ratio and phase, so the teeth stay meshed at every
 * angle — that IS the kinematic model. The contact normal never rotates: it is
 * the line of action itself, and the dots simply ride along it.
 *
 * The scene is rendered y-up (a `scale(1,-1)` wrap) so the pure math coordinates
 * from model/gear.ts map straight onto the SVG without sign juggling.
 */
import { createEffect, onCleanup, untrack } from "solid-js";
import {
  contactPoints,
  deg2rad,
  type GearGeometry,
  type MeshGeometry,
  type Pt,
  toPathD,
} from "../model/gear";
import { driveAngle, rpm, running, showConstruction, showContact } from "../model/store";

export interface SceneData {
  a: GearGeometry;
  b: GearGeometry;
  mesh: MeshGeometry;
}

const MAX_CONTACTS = 4;

export function GearMesh(props: { scene: SceneData }) {
  const s = () => props.scene;

  // --- declarative geometry (reactive to the scene) -------------------------
  const view = () => {
    const { a, b, mesh } = s();
    const pad = a.params.module * 0.8;
    const minX = -a.addendumRadius - pad;
    const maxX = mesh.center + b.addendumRadius + pad;
    const halfY = Math.max(a.addendumRadius, b.addendumRadius) + pad;
    return {
      x: minX,
      y: -halfY,
      w: maxX - minX,
      h: 2 * halfY,
    };
  };
  const viewBox = () => {
    const v = view();
    return `${v.x} ${v.y} ${v.w} ${v.h}`;
  };
  // stroke width in user units, constant on screen-ish
  const sw = () => s().a.params.module * 0.06;

  const circle = (cx: number, cy: number, r: number) =>
    `M ${cx - r} ${cy} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0`;

  // --- imperative refs ------------------------------------------------------
  let groupA!: SVGGElement;
  let groupB!: SVGGElement;
  let contactGroup!: SVGGElement;
  const dots: SVGCircleElement[] = [];
  const normals: SVGLineElement[] = [];

  // latest scene for the rAF loop (updated by an effect, not read reactively in the loop)
  let cur: SceneData | null = null;
  let angleDeg = untrack(() => driveAngle.get());
  let isRunning = untrack(() => running.get());
  let speed = untrack(() => rpm.get());
  let raf = 0;
  let last = 0;
  let lastPub = 0;

  const applyAngle = (deg: number) => {
    if (!cur) return;
    const { a, b, mesh } = cur;
    groupA.setAttribute("transform", `rotate(${deg})`);
    const thetaA = deg2rad(deg);
    const thetaB = mesh.phaseB - (a.params.teeth / b.params.teeth) * thetaA;
    groupB.setAttribute(
      "transform",
      `translate(${mesh.center} 0) rotate(${(thetaB * 180) / Math.PI})`,
    );
    // contact points + normals
    const pts: Pt[] = contactPoints(a, mesh, thetaA);
    const nlen = a.params.module * 1.1;
    for (let i = 0; i < MAX_CONTACTS; i++) {
      const dot = dots[i];
      const nl = normals[i];
      if (!dot || !nl) continue;
      if (i < pts.length) {
        const p = pts[i];
        dot.setAttribute("cx", `${p.x}`);
        dot.setAttribute("cy", `${p.y}`);
        dot.style.display = "";
        nl.setAttribute("x1", `${p.x - mesh.loaDir.x * nlen}`);
        nl.setAttribute("y1", `${p.y - mesh.loaDir.y * nlen}`);
        nl.setAttribute("x2", `${p.x + mesh.loaDir.x * nlen}`);
        nl.setAttribute("y2", `${p.y + mesh.loaDir.y * nlen}`);
        nl.style.display = "";
      } else {
        dot.style.display = "none";
        nl.style.display = "none";
      }
    }
  };

  const frame = (now: number) => {
    const dt = last ? (now - last) / 1000 : 0;
    last = now;
    if (isRunning) {
      angleDeg = (((angleDeg + speed * 6 * dt) % 360) + 360) % 360;
      applyAngle(angleDeg);
      if (now - lastPub > 250) {
        lastPub = now;
        // publish at ~4 Hz so the scrub slider + agent see the live angle
        driveAngle.set(Math.round(angleDeg * 2) / 2);
      }
    }
    raf = requestAnimationFrame(frame);
  };

  // keep `cur` fresh; re-apply so a geometry change redraws at the current angle
  createEffect(
    () => s(),
    (scene) => {
      cur = scene;
      applyAngle(angleDeg);
    },
  );
  // inbound control bridges (untracked handlers; read the value the source gave)
  createEffect(
    () => driveAngle.get(),
    (v) => {
      if (!isRunning) {
        angleDeg = v;
        applyAngle(v);
      }
    },
  );
  createEffect(
    () => running.get(),
    (v) => {
      isRunning = v;
      last = 0; // restart dt integration cleanly
    },
  );
  createEffect(
    () => rpm.get(),
    (v) => {
      speed = v;
    },
  );
  createEffect(
    () => showConstruction.get(),
    (v) => {
      const g = groupA?.ownerSVGElement?.querySelector<SVGGElement>(".construction");
      if (g) g.style.display = v ? "" : "none";
    },
  );
  createEffect(
    () => showContact.get(),
    (v) => {
      if (contactGroup) contactGroup.style.display = v ? "" : "none";
    },
  );

  raf = requestAnimationFrame(frame);
  onCleanup(() => cancelAnimationFrame(raf));

  return (
    <svg
      class="gear-svg"
      viewBox={viewBox()}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Two meshing gears with the construction overlay and contact point"
    >
      <title>Two meshing gears with the construction overlay and contact point</title>
      <g transform="scale(1,-1)">
        {/* construction overlay (behind the gears) */}
        <g class="construction" fill="none" stroke-width={sw()}>
          {/* line of centres */}
          <line class="axis-line" x1={0} y1={0} x2={s().mesh.center} y2={0} />
          {/* pitch circles */}
          <path class="pitch-circle gear-a" d={circle(0, 0, s().a.pitchRadius)} />
          <path class="pitch-circle gear-b" d={circle(s().mesh.center, 0, s().b.pitchRadius)} />
          {/* base circles */}
          <path class="base-circle gear-a" d={circle(0, 0, s().a.baseRadius)} />
          <path class="base-circle gear-b" d={circle(s().mesh.center, 0, s().b.baseRadius)} />
          {/* line of action (path of contact) — the fixed contact normal */}
          <line
            class="line-of-action"
            x1={s().mesh.loaStart.x}
            y1={s().mesh.loaStart.y}
            x2={s().mesh.loaEnd.x}
            y2={s().mesh.loaEnd.y}
          />
          {/* pitch point */}
          <circle
            class="pitch-point"
            cx={s().mesh.pitchPoint.x}
            cy={s().mesh.pitchPoint.y}
            r={s().a.params.module * 0.12}
          />
        </g>

        {/* gear A (driver) */}
        <g ref={groupA}>
          <path class="gear-body gear-a" d={toPathD(s().a.outline)} stroke-width={sw()} />
          <circle class="gear-hub gear-a" cx={0} cy={0} r={s().a.params.module * 0.5} />
        </g>
        {/* gear B (driven) */}
        <g ref={groupB}>
          <path class="gear-body gear-b" d={toPathD(s().b.outline)} stroke-width={sw()} />
          <circle class="gear-hub gear-b" cx={0} cy={0} r={s().b.params.module * 0.5} />
        </g>

        {/* contact overlay (above the gears) */}
        <g class="contact" ref={contactGroup} stroke-width={sw()}>
          {Array.from({ length: MAX_CONTACTS }, (_, i) => (
            <>
              <line
                class="contact-normal"
                ref={(el: SVGLineElement) => (normals[i] = el)}
                style={{ display: "none" }}
              />
              <circle
                class="contact-dot"
                r={s().a.params.module * 0.18}
                ref={(el: SVGCircleElement) => (dots[i] = el)}
                style={{ display: "none" }}
              />
            </>
          ))}
        </g>
      </g>
    </svg>
  );
}
