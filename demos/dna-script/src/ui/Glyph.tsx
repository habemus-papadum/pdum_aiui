/**
 * Glyph.tsx — the notation as marks on screen (playbook layer 3: pure readers,
 * geometry in, DOM out). Nothing here decides what a glyph *means*; the shapes
 * come from model/glyph.ts and the pairing rules from model/dna.ts.
 *
 * `Glyph` is sized in `em` on purpose: set at 1.5em it sits in running text at
 * whatever size the surrounding paragraph is, which is what makes the notation
 * usable inline rather than only in figures.
 */
import { Repeat } from "solid-js";
import { type Base, pairKind } from "../model/dna";
import {
  DEFAULT_METRICS,
  type GlyphMetrics,
  glyphFillPath,
  glyphOutlinePath,
  glyphViewBox,
} from "../model/glyph";

/** Width : height of the padded cell — what keeps `em` sizing proportional. */
function aspect(m: GlyphMetrics): number {
  return m.width / (m.height + 2 * m.amp);
}

/** One base. `height` is any CSS length; the width follows from the viewBox. */
export function Glyph(props: {
  base: Base;
  height?: string;
  metrics?: GlyphMetrics;
  class?: string;
}) {
  const m = () => props.metrics ?? DEFAULT_METRICS;
  const height = () => props.height ?? "1.5em";
  return (
    <svg
      class={`glyph glyph-${pairKind(props.base)}${props.class ? ` ${props.class}` : ""}`}
      viewBox={glyphViewBox(m())}
      style={{ height: height(), width: `calc(${height()} * ${aspect(m()).toFixed(5)})` }}
      role="img"
      aria-label={props.base}
    >
      <path class="glyph-fill" d={glyphFillPath(props.base, m())} />
      <path class="glyph-outline" d={glyphOutlinePath(props.base, m())} />
    </svg>
  );
}

/**
 * A run of bases set flush, the way a word is set from letters. Cells butt
 * together with no gap, so a strand reads as one ribbon with a bumpy edge.
 */
export function Strand(props: {
  seq: readonly Base[];
  height?: string;
  metrics?: GlyphMetrics;
  class?: string;
}) {
  return (
    // role="img" both licenses the aria-label and makes this a leaf for
    // assistive tech, so the run is announced as one sequence rather than as
    // four-and-twenty separate letters.
    <span
      class={props.class ? `strand ${props.class}` : "strand"}
      role="img"
      aria-label={props.seq.join("")}
    >
      <Repeat count={props.seq.length}>
        {(i) => <Glyph base={props.seq[i]} height={props.height} metrics={props.metrics} />}
      </Repeat>
    </span>
  );
}
