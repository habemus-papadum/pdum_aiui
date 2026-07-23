/**
 * Duplex.tsx — the two-row diagram: a strand above, its partner below.
 *
 * The partner row is drawn by the SAME glyph paths as the top row, placed by
 * `placedTransform` — an SVG `rotate(180 …)`. That matters: the meshing is not
 * a second drawing that happens to fit, it is the identical shape turned over.
 * `glyph.test.ts` checks that same rotation arithmetically.
 *
 * Letters ride in HTML grids above and below rather than inside the SVG, so
 * they stay real selectable text at any glyph size; both grids use the same
 * column width as the diagram, so the columns line up.
 */
import { Repeat, Show } from "solid-js";
import type { Base } from "../model/dna";
import { pairKind } from "../model/dna";
import {
  DEFAULT_METRICS,
  type DuplexLayout,
  duplexViewBox,
  type GlyphMetrics,
  glyphFillPath,
  glyphOutlinePath,
  placedTransform,
} from "../model/glyph";

function Row(props: { cells: DuplexLayout["top"]; metrics: GlyphMetrics }) {
  return (
    <Repeat count={props.cells.length}>
      {(i) => {
        const g = () => props.cells[i];
        return (
          <g
            class={`duplex-cell duplex-cell-${pairKind(g().base)}`}
            transform={placedTransform(g(), props.metrics)}
            data-base={g().base}
          >
            <path class="glyph-fill" d={glyphFillPath(g().base, props.metrics)} />
            <path class="glyph-outline" d={glyphOutlinePath(g().base, props.metrics)} />
          </g>
        );
      }}
    </Repeat>
  );
}

function Letters(props: { bases: Base[]; class?: string }) {
  return (
    <div
      class={props.class ? `duplex-letters ${props.class}` : "duplex-letters"}
      aria-hidden="true"
    >
      <Repeat count={props.bases.length}>{(i) => <span>{props.bases[i]}</span>}</Repeat>
    </div>
  );
}

export function Duplex(props: {
  layout: DuplexLayout;
  /** Height of ONE base cell, px — the notation's type size. */
  size: number;
  showLetters?: boolean;
  metrics?: GlyphMetrics;
}) {
  const m = () => props.metrics ?? DEFAULT_METRICS;
  /** User px per glyph unit. */
  const scale = () => props.size / m().height;
  const cellPx = () => m().width * scale();
  const svgWidth = () => props.layout.width * scale();
  const svgHeight = () => (props.layout.height + 2 * m().amp) * scale();

  return (
    <div class="duplex" style={{ "--cell": `${cellPx()}px`, "--strand-w": `${svgWidth()}px` }}>
      <Show when={props.showLetters}>
        <Letters bases={props.layout.top.map((g) => g.base)} />
      </Show>

      <div class="duplex-figure">
        <span class="duplex-end duplex-end-tl">5′</span>
        <span class="duplex-end duplex-end-tr">3′</span>
        <svg
          class="duplex-svg"
          viewBox={duplexViewBox(props.layout, m())}
          width={svgWidth()}
          height={svgHeight()}
          role="img"
          aria-label={`${props.layout.top.map((g) => g.base).join("")} over ${props.layout.bottom
            .map((g) => g.base)
            .join("")}`}
        >
          <g class="duplex-row duplex-row-top">
            <Row cells={props.layout.top} metrics={m()} />
          </g>
          <g class="duplex-row duplex-row-bottom">
            <Row cells={props.layout.bottom} metrics={m()} />
          </g>
        </svg>
        <span class="duplex-end duplex-end-bl">
          {props.layout.bottom[0]?.rotated ? "3′" : "5′"}
        </span>
        <span class="duplex-end duplex-end-br">
          {props.layout.bottom[0]?.rotated ? "5′" : "3′"}
        </span>
      </div>

      <Show when={props.showLetters}>
        <Letters bases={props.layout.bottom.map((g) => g.base)} class="duplex-letters-lower" />
      </Show>
    </div>
  );
}
