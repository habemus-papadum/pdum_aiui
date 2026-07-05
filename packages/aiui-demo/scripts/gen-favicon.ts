/**
 * gen-favicon.ts — generate the demo's favicon from its own Aztec code.
 *
 * The favicon *is* the thing the demo draws: a uniformly-random domino tiling
 * of the Aztec diamond AD(n). We reuse the real EKLP shuffle (shuffle.ts) and
 * the real domino palette (palette.ts) so the icon can never drift from the
 * page — same algorithm, same colors. The `Tiling` already carries each domino
 * with its anchor + type, so we draw straight from `dominoes` (no need for
 * render.ts's grid/anchor reconstruction) and emit a transparent-background
 * SVG: the diamond sits on nothing, its four square corners simply uncovered,
 * so the mark reads on a light or dark browser tab alike.
 *
 * Run: pnpm --filter @habemus-papadum/aiui-demo gen:favicon [seed] [order]
 * Output: public/favicon.svg  (rasterized to public/favicon.png separately —
 * see scripts/gen-favicon.sh, which screenshots this SVG with a transparent
 * background via headless Chrome, honoring the "no background" ask).
 */
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COLOR } from "../src/pages/aztec/palette";
import { mulberry32 } from "../src/pages/aztec/rng";
import { dominoCells, generate } from "../src/pages/aztec/shuffle";
import { N, S } from "../src/pages/aztec/types";

const here = dirname(fileURLToPath(import.meta.url));

// Match render.ts: an 8%-of-a-cell seam so neighbouring dominoes read as
// separate bricks (the "arctic brickwork").
const GAP = 0.08;

/** Emit the diamond as a transparent SVG, one <rect> per domino. */
function toSvg(order: number, seed: number): string {
  const tiling = generate(order, mulberry32(seed));
  const size = 2 * order; // grid side, in cells = the viewBox extent

  const rects: string[] = [];
  for (const d of tiling.dominoes) {
    const [[r, c]] = dominoCells(d);
    const horizontal = d.t === N || d.t === S;
    const w = horizontal ? 2 : 1;
    const h = horizontal ? 1 : 2;
    // Inset by the seam on every side (same brickwork gap as the canvas).
    const x = (c + GAP).toFixed(3);
    const y = (r + GAP).toFixed(3);
    const rw = (w - 2 * GAP).toFixed(3);
    const rh = (h - 2 * GAP).toFixed(3);
    rects.push(`<rect x="${x}" y="${y}" width="${rw}" height="${rh}" fill="${COLOR[d.t]}"/>`);
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" `,
    `shape-rendering="geometricPrecision">`,
    `<title>Aztec diamond AD(${order}) — aiui demo</title>`,
    rects.join(""),
    `</svg>`,
    "",
  ].join("\n");
}

const seed = Number(process.argv[2] ?? 7);
const order = Number(process.argv[3] ?? 10);
const out = resolve(here, "../public/favicon.svg");
writeFileSync(out, toSvg(order, seed));
console.log(`favicon: AD(${order}), seed ${seed} → ${out}`);
