/**
 * overlays.tsx — small pieces drawn over a FieldMap. SVG parts render in the
 * map's WORLD coordinates (z horizontal, x up; strokes use non-scaling px).
 * Anything needing screen-true shape or text (dots, ghost markers, labels)
 * is HTML positioned by world→fraction conversion instead — the map's aspect
 * is not isotropic, so an SVG circle would render as an ellipse.
 */

import type { MapExtent, Rgb } from "@habemus-papadum/aiui-optics";
import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";

export const css = ([r, g, b]: Rgb): string =>
  `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;

/** Dashed guide ray from (z0, x0) along direction sinθ (SVG, world coords). */
export function Ray(props: {
  from?: { z: number; x: number };
  sin: number;
  length?: number;
  color?: string;
  width?: number;
  dash?: string;
}): JSX.Element {
  const f = () => props.from ?? { z: 0, x: 0 };
  const c = () => Math.sqrt(Math.max(0.01, 1 - props.sin * props.sin));
  const L = () => props.length ?? 2000;
  return (
    <line
      x1={f().z}
      y1={f().x}
      x2={f().z + L() * c()}
      y2={f().x + L() * props.sin}
      stroke={props.color ?? "rgba(230, 210, 74, 0.75)"}
      stroke-width={props.width ?? 1.2}
      stroke-dasharray={props.dash ?? "6 5"}
      vector-effect="non-scaling-stroke"
    />
  );
}

/** A vertical reference line at plane z (SVG, world coords). */
export function PlaneLine(props: {
  z: number;
  xHalf: number;
  color?: string;
  dash?: string;
}): JSX.Element {
  return (
    <line
      x1={props.z}
      y1={-props.xHalf}
      x2={props.z}
      y2={props.xHalf}
      stroke={props.color ?? "rgba(140, 150, 170, 0.6)"}
      stroke-width={1.2}
      stroke-dasharray={props.dash ?? "3 5"}
      vector-effect="non-scaling-stroke"
    />
  );
}

// --- HTML overlay bits (screen-true circles + labels) -------------------------

const pct = (v: number): string => `${(v * 100).toFixed(2)}%`;

/** Position a child at world (z, x) over a map (parent must wrap the FieldMap
 *  in a position:relative container filling the same box). */
export function MapDot(props: {
  extent: MapExtent;
  z: number;
  x: number;
  kind?: "probe" | "ghost" | "source" | "twin";
  label?: string;
  color?: string;
  visible?: boolean;
}): JSX.Element {
  const fx = () => (props.z - props.extent.z0) / (props.extent.z1 - props.extent.z0);
  const fy = () => (props.extent.x1 - props.x) / (props.extent.x1 - props.extent.x0);
  const inside = () => fx() >= 0 && fx() <= 1 && fy() >= 0 && fy() <= 1;
  return (
    <Show when={(props.visible ?? true) && inside()}>
      <div
        class={`map-dot map-dot-${props.kind ?? "ghost"}`}
        style={{
          left: pct(fx()),
          top: pct(fy()),
          ...(props.color ? { "--dot-color": props.color } : {}),
        }}
      >
        <Show when={props.label}>
          <span class="map-dot-label">{props.label}</span>
        </Show>
      </div>
    </Show>
  );
}
