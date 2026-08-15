/**
 * previews.tsx — the HUD thumbnails: one cheap, PURE mini-view per slide (the
 * DemoCard discipline at slide scale — the HUD mounts all of them at once, so
 * none may touch the cell graph, the controls, or a rAF). Static geometry is
 * computed once per mount from demo-gears' pure functions at the talk's
 * standard parameters.
 */
import { gearGeometry, meshGeometry, toPathD } from "@habemus-papadum/demo-gears/gear";
import type { JSX } from "@solidjs/web";
import { AnatomySvg, InvoluteSvg } from "../ui/figures";

const STD = { module: 8, pressureAngle: 20, addendum: 1, dedendum: 1.25 };

/** A static meshing pair (no rotation, no cells) for pair-drawing slides. */
function PairMini(props: { showLoa?: boolean }): JSX.Element {
  const a = gearGeometry({ teeth: 13, ...STD });
  const b = gearGeometry({ teeth: 21, ...STD });
  const mesh = meshGeometry(a, b);
  const pad = STD.module * 1.4;
  const minX = -a.addendumRadius - pad;
  const maxX = mesh.center + b.addendumRadius + pad;
  const halfY = Math.max(a.addendumRadius, b.addendumRadius) + pad;
  return (
    <svg
      viewBox={`${minX} ${-halfY} ${maxX - minX} ${2 * halfY}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="a meshing gear pair"
      class="talk-mini"
    >
      <title>a meshing gear pair</title>
      <g transform="scale(1,-1)">
        <path class="fig-gear" d={toPathD(a.outline)} />
        <g transform={`translate(${mesh.center} 0) rotate(${(mesh.phaseB * 180) / Math.PI})`}>
          <path class="fig-gear fig-gear-b" d={toPathD(b.outline)} />
        </g>
        {props.showLoa === true && (
          <line
            class="fig-loa"
            x1={mesh.loaStart.x}
            y1={mesh.loaStart.y}
            x2={mesh.loaEnd.x}
            y2={mesh.loaEnd.y}
          />
        )}
      </g>
    </svg>
  );
}

export const TitlePreview = (): JSX.Element => (
  <div class="talk-mini-tile">
    <PairMini />
    <span class="talk-mini-word">The Involute Gear</span>
  </div>
);

export const InvolutePreview = (): JSX.Element => (
  <InvoluteSvg class="talk-mini" label="an involute unwinding" />
);

export const AnatomyPreview = (): JSX.Element => (
  <AnatomySvg
    gear={gearGeometry({ teeth: 13, ...STD })}
    class="talk-mini"
    label="a gear with construction circles"
  />
);

export const MeshPreview = (): JSX.Element => <PairMini showLoa />;

export const DesignPreview = (): JSX.Element => (
  <div class="talk-mini-tile">
    <span class="talk-mini-stat">1.62:1</span>
    <span class="talk-mini-word">ratio · contact · centre</span>
  </div>
);

export const ColophonPreview = (): JSX.Element => (
  <div class="talk-mini-tile">
    <span class="talk-mini-word">fin · made with aiui-slides</span>
  </div>
);
