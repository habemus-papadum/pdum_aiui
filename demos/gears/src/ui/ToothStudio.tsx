/**
 * ToothStudio.tsx — Layer 3: the single-tooth view.
 *
 * A zoomed window onto one gear's rim so a tooth and its neighbouring space are
 * both visible: the filled profile is the tooth (the positive, the material),
 * and the panel background showing through the gaps is its negative — the
 * cavity a mating tooth drops into. Every parameter (teeth, module, pressure
 * angle, addendum, dedendum) reshapes it live. Reads the gear cells through the
 * `graph()` accessor and switches which gear it inspects via `studioGear`.
 */
import { CellView } from "@habemus-papadum/aiui-viz";
import { type GearGeometry, toPathD } from "../model/gear";
import { graph } from "../model/graph";
import { studioGear } from "../model/store";

function circlePath(r: number): string {
  return `M ${-r} 0 a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0`;
}

function StudioFigure(props: { g: GearGeometry }) {
  const g = () => props.g;
  const view = () => {
    const m = g().params.module;
    const cy = g().pitchRadius; // window centred on the top of the rim
    const halfW = m * 6;
    const halfH = (g().addendumRadius - g().rootRadius) / 2 + m * 1.2;
    // flipped (scale 1,-1): math (x,y) → svg (x,−y)
    return {
      box: `${-halfW} ${-(cy + halfH)} ${2 * halfW} ${2 * halfH}`,
      sw: m * 0.05,
    };
  };
  return (
    <svg
      class="tooth-svg"
      viewBox={view().box}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="A single gear tooth and its neighbouring space"
    >
      <title>A single gear tooth and its neighbouring space</title>
      <g transform="scale(1,-1)">
        <g class="tooth-guides" fill="none" stroke-width={view().sw}>
          <path class="ref-circle addendum" d={circlePath(g().addendumRadius)} />
          <path class="ref-circle pitch" d={circlePath(g().pitchRadius)} />
          <path class="ref-circle base" d={circlePath(g().baseRadius)} />
          <path class="ref-circle root" d={circlePath(g().rootRadius)} />
        </g>
        <path class="tooth-body" d={toPathD(g().outline)} stroke-width={view().sw} />
      </g>
    </svg>
  );
}

export function ToothStudio() {
  const cell = () => (studioGear.get() === "A" ? graph().gearA : graph().gearB);
  return (
    <div class="studio">
      <div class="studio-tabs">
        <button
          type="button"
          class="chip"
          data-active={studioGear.get() === "A" ? "" : undefined}
          onClick={() => studioGear.set("A")}
        >
          Gear A
        </button>
        <button
          type="button"
          class="chip"
          data-active={studioGear.get() === "B" ? "" : undefined}
          onClick={() => studioGear.set("B")}
        >
          Gear B
        </button>
      </div>
      <CellView of={cell()}>{(v) => <StudioFigure g={v()} />}</CellView>
      <div class="studio-legend">
        <span>
          <i class="sw tooth" /> tooth — the material (positive)
        </span>
        <span>
          <i class="sw space" /> space — the mating cavity (negative)
        </span>
        <span class="muted">
          dashed: addendum · <span class="accent">pitch</span> · base · root circles
        </span>
      </div>
    </div>
  );
}
