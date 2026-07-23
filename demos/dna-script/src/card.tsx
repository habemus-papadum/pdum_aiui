/**
 * card.tsx — the landing card: a live miniature of the notation, cycling
 * through a few strands so the meshing edge and the two-tone fill are both
 * visible at a glance.
 *
 * Built from the pure model only (model/dna + model/glyph — no store, no
 * graph), and styled with inline attributes rather than the page stylesheet,
 * since a shell mounts this without loading the app's CSS.
 */
import type { DemoCard } from "@habemus-papadum/aiui-viz";
import { createSignal, onCleanup, Repeat } from "solid-js";
import { type Base, pairKind, parseSequence } from "./model/dna";
import {
  DEFAULT_METRICS,
  duplexLayout,
  duplexViewBox,
  glyphFillPath,
  glyphOutlinePath,
  placedTransform,
} from "./model/glyph";

const M = DEFAULT_METRICS;
const AT = "#8ab4f8";
const GC = "#f6a5bd";
const LINE = "#4b5468";

/** Palindromes and one strand that is not, so the card shows both readings. */
const SHOWN = ["GAATTC", "GGATCC", "ATGGCA", "AAGCTT"];

function Cell(props: { g: ReturnType<typeof duplexLayout>["top"][number] }) {
  const fill = () => (pairKind(props.g.base) === "AT" ? AT : GC);
  return (
    <g transform={placedTransform(props.g, M)}>
      <path d={glyphFillPath(props.g.base, M)} fill={fill()} />
      <path
        d={glyphOutlinePath(props.g.base, M)}
        fill="none"
        stroke={LINE}
        stroke-width="0.8"
        stroke-linejoin="round"
      />
    </g>
  );
}

function Preview() {
  const [which, setWhich] = createSignal(0);
  const timer = setInterval(() => setWhich((n) => (n + 1) % SHOWN.length), 2600);
  onCleanup(() => clearInterval(timer));

  const bases = (): Base[] => parseSequence(SHOWN[which()]).bases;
  const layout = () => duplexLayout(bases(), M);

  return (
    <div
      style={{
        display: "flex",
        "align-items": "center",
        "justify-content": "center",
        height: "100%",
        padding: "10px",
      }}
    >
      <svg
        viewBox={duplexViewBox(layout(), M)}
        width="168"
        style={{ overflow: "visible" }}
        role="img"
        aria-label={`${SHOWN[which()]} paired with its reverse complement`}
      >
        <g>
          <Repeat count={layout().top.length}>{(i) => <Cell g={layout().top[i]} />}</Repeat>
        </g>
        <g>
          <Repeat count={layout().bottom.length}>{(i) => <Cell g={layout().bottom[i]} />}</Repeat>
        </g>
      </svg>
    </div>
  );
}

export const card: DemoCard = {
  blurb:
    "A notation for DNA where the shapes carry the biology: complementary bases interlock, " +
    "and a strand set against its reverse complement — turned 180° — zips shut.",
  Preview,
};
