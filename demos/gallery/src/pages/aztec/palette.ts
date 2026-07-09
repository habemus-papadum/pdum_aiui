/**
 * palette.ts — the four categorical domino colors and their labels.
 *
 * These are *figure* colors: constant across light and dark modes. The canvas
 * renders as a self-contained dark plate (render.ts keeps its own dark
 * background) in both modes, and the legend is a key to that plate — so its
 * swatches must match the plate, not the page. They are validated against both
 * the dark panel/canvas surface *and* the light legend panel (#ffffff): all
 * four sit in the light lightness band L 0.43–0.77 (a superset here of the dark
 * band 0.48–0.67), clear the chroma floor, keep worst-adjacent CVD ΔE 31.2
 * (target ≥ 12), and pass 3:1 contrast on both surfaces — so a domino reads
 * whether it is on the dark canvas or a white legend chip. Fixed assignment by
 * domino type: color follows the entity, and the legend + brickwork orientation
 * give a second, non-color channel of identity. (The frozen-fraction *chart*
 * line is a per-mode color from src/site/theme.ts — a chart on a panel, not a
 * figure mark.)
 */
import { E, N, S, W } from "./types";

export const COLOR = {
  [N]: "#4a86dd", // north — blue
  [E]: "#c9822f", // east — amber
  [S]: "#2fa876", // south — green
  [W]: "#9b6fdb", // west — purple
} as const;

/** Legend / color-key rows, in the canonical N · E · S · W order. */
export const LEGEND: { type: 1 | 2 | 3 | 4; name: string; moves: string; color: string }[] = [
  { type: N, name: "N", moves: "horizontal · slides up", color: COLOR[N] },
  { type: E, name: "E", moves: "vertical · slides right", color: COLOR[E] },
  { type: S, name: "S", moves: "horizontal · slides down", color: COLOR[S] },
  { type: W, name: "W", moves: "vertical · slides left", color: COLOR[W] },
];
