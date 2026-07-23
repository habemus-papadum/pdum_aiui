/**
 * GlyphKey.tsx — the alphabet, and the two pairs shown meshing.
 *
 * The pair demonstrations are built by handing `duplexLayout` a one-base
 * strand, so they are the ordinary duplex renderer with n = 1 rather than a
 * special drawing that could quietly disagree with the real one.
 */
import { Repeat } from "solid-js";
import { BASES, type Base, complement, pairKind } from "../model/dna";
import { DEFAULT_METRICS, duplexLayout, PROFILE } from "../model/glyph";
import { Duplex } from "./Duplex";
import { Glyph } from "./Glyph";

const FAMILY_WORD = { round: "round", angular: "angular" } as const;

function describe(base: Base): string {
  const p = PROFILE[base];
  const bump = p.polarity > 0 ? "tooth" : "socket";
  return `${FAMILY_WORD[p.family]} ${bump}, ${p.fill} solid`;
}

/** The four glyphs, each with the three features that define it. */
export function GlyphKey(props: { size?: string }) {
  return (
    <div class="key-grid">
      <Repeat count={BASES.length}>
        {(i) => {
          const base = () => BASES[i];
          return (
            <figure class={`key-card key-card-${pairKind(base())}`} data-base={base()}>
              <Glyph base={base()} height={props.size ?? "3.2em"} />
              <figcaption>
                <b>{base()}</b>
                <span class="muted">{describe(base())}</span>
              </figcaption>
            </figure>
          );
        }}
      </Repeat>
    </div>
  );
}

/** One pair, meshed: the base above, its complement below and turned. */
export function PairDemo(props: { base: Base; size?: number }) {
  const layout = () => duplexLayout([props.base], DEFAULT_METRICS);
  return (
    <figure class="pair-demo" data-pair={pairKind(props.base)}>
      <Duplex layout={layout()} size={props.size ?? 56} showLetters={false} />
      <figcaption>
        <b>
          {props.base}·{complement(props.base)}
        </b>{" "}
        <span class="muted">
          {PROFILE[props.base].family === "round"
            ? "round bump — and the solid halves sit outside the join"
            : "angular bump — and the solid halves meet across the join"}
        </span>
      </figcaption>
    </figure>
  );
}
