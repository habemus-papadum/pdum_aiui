/**
 * FoldFigure.tsx — the folded strand (playbook layer 3: a pure reader of the
 * layout).
 *
 * Every cell is drawn by the same two paths as the flat duplex; only the
 * transform differs, and it comes from `placedBaseTransform`. So a helix in a
 * fold and a helix in a duplex are the same picture — which is the point.
 */
import { Repeat, Show } from "solid-js";
import { pairKind } from "../model/dna";
import type { FoldLayout, PlacedBase } from "../model/foldLayout";
import { placedBaseTransform } from "../model/foldLayout";
import {
  DEFAULT_METRICS,
  type GlyphMetrics,
  glyphFillPath,
  glyphOutlinePath,
} from "../model/glyph";

function FoldCell(props: { b: PlacedBase; metrics: GlyphMetrics }) {
  const cls = () =>
    [
      "duplex-cell",
      `duplex-cell-${pairKind(props.b.base)}`,
      props.b.partner < 0 ? "fold-unpaired" : "fold-paired",
    ].join(" ");
  return (
    <g
      class={cls()}
      transform={placedBaseTransform(props.b, props.metrics)}
      data-base={props.b.base}
      data-index={props.b.index}
    >
      <path class="glyph-fill" d={glyphFillPath(props.b.base, props.metrics)} />
      <path class="glyph-outline" d={glyphOutlinePath(props.b.base, props.metrics)} />
    </g>
  );
}

/**
 * A small tick naming the 5' or 3' terminus, set clear of the strand.
 *
 * A terminal base is usually the end of a helix, so "outward" is *away from its
 * partner* (±v), not a fixed angle — otherwise the label lands on the other
 * strand of the same ladder. An unpaired terminus has no partner to steer by,
 * so it steps back along the backbone instead.
 */
function EndMark(props: { b: PlacedBase; label: string; metrics: GlyphMetrics; back: boolean }) {
  const dir = () => {
    const a = (props.b.angle * Math.PI) / 180;
    const u = { x: Math.cos(a), y: Math.sin(a) };
    if (props.b.partner < 0) {
      const s = props.back ? -1 : 1;
      return { x: u.x * s, y: u.y * s };
    }
    // v = rot90(u) points from the 5' strand toward the 3' strand.
    const s = props.b.turned ? 1 : -1;
    return { x: -u.y * s, y: u.x * s };
  };
  const away = () => props.metrics.height * 0.85;
  return (
    <text
      class="fold-end"
      x={props.b.cx + dir().x * away()}
      y={props.b.cy + dir().y * away()}
      text-anchor="middle"
      dominant-baseline="middle"
      font-size={`${props.metrics.height * 0.55}`}
    >
      {props.label}
    </text>
  );
}

export function FoldFigure(props: {
  layout: FoldLayout;
  /** Height of one base cell, px. */
  size: number;
  metrics?: GlyphMetrics;
  showEnds?: boolean;
}) {
  const m = () => props.metrics ?? DEFAULT_METRICS;
  const scale = () => props.size / m().height;
  const pad = () => m().width * 0.9;
  const box = () => {
    const l = props.layout;
    const w = Math.max(l.maxX - l.minX, m().width) + 2 * pad();
    const h = Math.max(l.maxY - l.minY, m().height) + 2 * pad();
    return { x: l.minX - pad(), y: l.minY - pad(), w, h };
  };
  const first = () => props.layout.bases.find((b) => b.index === 0);
  const last = () => {
    const bs = props.layout.bases;
    return bs.reduce<PlacedBase | undefined>(
      (a, b) => (!a || b.index > a.index ? b : a),
      undefined,
    );
  };

  return (
    <svg
      class="fold-svg"
      viewBox={`${box().x} ${box().y} ${box().w} ${box().h}`}
      width={box().w * scale()}
      height={box().h * scale()}
      role="img"
      aria-label="folded strand"
    >
      <Repeat count={props.layout.bases.length}>
        {(i) => <FoldCell b={props.layout.bases[i]} metrics={m()} />}
      </Repeat>
      <Show when={props.showEnds !== false && first()}>
        {(b) => <EndMark b={b()} label="5′" metrics={m()} back={true} />}
      </Show>
      <Show when={props.showEnds !== false && last()}>
        {(b) => <EndMark b={b()} label="3′" metrics={m()} back={false} />}
      </Show>
    </svg>
  );
}
