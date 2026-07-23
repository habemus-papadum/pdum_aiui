/**
 * foldLayout.ts — placing a folded strand on the page (playbook layer 1: pure
 * geometry, tested).
 *
 * ## The idea
 *
 * A nested structure is a tree of **loops** joined by **helices**, so the
 * layout is a tree walk. The two element types are drawn quite differently, and
 * both fall out of the notation rather than fighting it:
 *
 * - A **helix** is a straight ladder — and a ladder is exactly the duplex from
 *   `glyph.ts`, rotated: the 5' strand runs along the axis, the 3' strand runs
 *   back alongside it one cell-height away and turned 180°, so the teeth mesh
 *   for the same reason they do in a flat duplex.
 * - A **loop** is a circle through the bases that bound it. Its radius is not
 *   free: adjacent bases must sit one backbone step `W` apart, except the two
 *   halves of a base pair, which must sit `H` apart. So the radius solves
 *
 *       nH · 2·asin(H/2r)  +  nW · 2·asin(W/2r)  =  2π
 *
 *   which has no closed form — `loopRadius` bisects it. This is the classic
 *   "radiate" layout (Bruccoleri–Heinrich, and what VARNA calls radiate).
 *
 * Helices leave a loop along the outward radius through their two bases, which
 * is what keeps branches from folding back over the loop they came from.
 *
 * The exterior (everything not enclosed by a pair) is laid along a horizontal
 * baseline instead of a circle, with its helices standing up from it — for a
 * linear strand that reads far better than a giant enclosing circle.
 *
 * ## What this does not do
 *
 * Nothing here prevents two *different* branches from overlapping. Real drawing
 * programs run a relaxation pass to push them apart; this does not, so a
 * structure with many branches can collide. `overlappingPairs` reports it so a
 * caller can say so rather than silently drawing a lie.
 */
import type { Base } from "./dna";
import { helixLength, type PairTable } from "./fold";
import type { GlyphMetrics } from "./glyph";

/** One base, placed. Position is the **centre** of the glyph cell. */
export interface PlacedBase {
  index: number;
  base: Base;
  cx: number;
  cy: number;
  /** Rotation of the cell frame, degrees. Local +x runs along the backbone. */
  angle: number;
  /** Turned a further 180° — the 3' strand of a helix, as in the duplex. */
  turned: boolean;
  /** Partner index, or -1. */
  partner: number;
}

export interface FoldLayout {
  bases: PlacedBase[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * The radius at which a loop's bases sit exactly one step apart: `nH` gaps of
 * length `H` (base pairs) and `nW` gaps of length `W` (backbone steps) must
 * close a full turn. Monotone in r, so bisection is enough.
 */
export function loopRadius(nH: number, nW: number, H: number, W: number): number {
  const floor = Math.max(H, W) / 2 + 1e-9;
  const f = (r: number) =>
    nH * 2 * Math.asin(Math.min(1, H / (2 * r))) +
    nW * 2 * Math.asin(Math.min(1, W / (2 * r))) -
    2 * Math.PI;
  // Too few slots to close a circle at any legal radius — the loop is as tight
  // as it can get.
  if (f(floor) <= 0) return floor;
  let lo = floor;
  let hi = floor * 2;
  for (let k = 0; k < 200 && f(hi) > 0; k++) hi *= 2;
  for (let k = 0; k < 120; k++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Gap between two consecutive exterior elements, beyond their own width. */
const EXTERIOR_GAP = 0.4;

/**
 * Floor on a loop's radius, as a multiple of the cell height.
 *
 * The chord equation treats bases as points, which is what every RNA drawing
 * program assumes — they draw a letter, not a tile. Our bases are cells `H`
 * tall standing radially, so a circle sized purely by chord length can be
 * *smaller than the cells standing on it*: a four-base loop solves to r ≈ 0.8H,
 * and the cells then converge on the centre and overlap. Below this floor the
 * loop is opened up and the slack is shared among the backbone gaps — a loop is
 * slack in reality too, so spacing its bases apart is honest. Pair chords stay
 * exactly `H` regardless, because that is what makes the teeth meet.
 */
const MIN_LOOP_RADIUS = 1.15;

export function layoutFold(seq: readonly Base[], pairs: PairTable, m: GlyphMetrics): FoldLayout {
  const n = seq.length;
  const placed: Array<PlacedBase | undefined> = new Array(n);
  const { width: W, height: H } = m;

  const put = (index: number, cx: number, cy: number, rad: number, turned: boolean) => {
    placed[index] = {
      index,
      base: seq[index],
      cx,
      cy,
      angle: (rad * 180) / Math.PI,
      turned,
      partner: pairs[index],
    };
  };

  /**
   * Lay a helix from its outermost pair, growing along `u`. The 3' strand sits
   * at +v where v = rot90(u) — the same handedness the flat duplex uses, which
   * is what makes the teeth mesh.
   */
  const placeHelix = (i: number, j: number, cx: number, cy: number, ux: number, uy: number) => {
    const vx = -uy;
    const vy = ux;
    const rad = Math.atan2(uy, ux);
    const L = helixLength(pairs, i, j);
    for (let t = 0; t < L; t++) {
      const ox = cx + t * W * ux;
      const oy = cy + t * W * uy;
      put(i + t, ox, oy, rad, false);
      put(j - t, ox + H * vx, oy + H * vy, rad, true);
    }
    placeLoop(i + L - 1, j - L + 1, ux, uy);
  };

  /**
   * Lay the loop closed by `(i, j)`, whose two bases are already placed by the
   * helix that arrived here. The loop bulges in the +u direction.
   */
  const placeLoop = (i: number, j: number, ux: number, uy: number) => {
    // Slots around the circle, in strand order: the closing pair, every
    // unpaired base, and both halves of each child pair.
    const slots: number[] = [i];
    for (let k = i + 1; k <= j - 1; k++) {
      const p = pairs[k];
      if (p > k) {
        slots.push(k, p);
        k = p;
      } else if (p === -1) {
        slots.push(k);
      }
    }
    slots.push(j);
    const M = slots.length;
    if (M < 3) return; // nothing between the closing pair

    const chord: number[] = [];
    let nH = 0;
    for (let s = 0; s < M; s++) {
      const a = slots[s];
      const b = slots[(s + 1) % M];
      const isPair = pairs[a] === b;
      chord.push(isPair ? H : W);
      if (isPair) nH++;
    }
    // Open the loop up if the cells standing on it would not fit (see
    // MIN_LOOP_RADIUS), then share the slack among the backbone gaps only.
    const r = Math.max(loopRadius(nH, M - nH, H, W), H * MIN_LOOP_RADIUS);
    const pairAngle = 2 * Math.asin(Math.min(1, H / (2 * r)));
    const stepCount = M - nH;
    const stepAngle = stepCount > 0 ? (2 * Math.PI - nH * pairAngle) / stepCount : 0;
    const advance = chord.map((c) => (c === H ? pairAngle : stepAngle));

    const Pi = placed[i];
    const Pj = placed[j];
    if (!Pi || !Pj) return;
    const midX = (Pi.cx + Pj.cx) / 2;
    const midY = (Pi.cy + Pj.cy) / 2;
    const h = Math.sqrt(Math.max(0, r * r - (H / 2) * (H / 2)));
    const Cx = midX + h * ux;
    const Cy = midY + h * uy;

    const phi0 = Math.atan2(Pi.cy - Cy, Pi.cx - Cx);
    // Travel around the circle the way that leads *into* the loop, not back
    // down the helix we came from.
    const sign = -Math.sin(phi0) * ux + Math.cos(phi0) * uy > 0 ? 1 : -1;

    let phi = phi0;
    for (let s = 0; s < M; s++) {
      const idx = slots[s];
      const px = Cx + r * Math.cos(phi);
      const py = Cy + r * Math.sin(phi);
      const tangent = Math.atan2(sign * Math.cos(phi), -sign * Math.sin(phi));

      if (s > 0 && s < M - 1) {
        const partner = pairs[idx];
        if (partner > idx) {
          // A child helix: both halves are consecutive slots on this circle.
          const nextPhi = phi + sign * advance[s];
          const qx = Cx + r * Math.cos(nextPhi);
          const qy = Cy + r * Math.sin(nextPhi);
          const dx = qx - px;
          const dy = qy - py;
          const len = Math.hypot(dx, dy) || 1;
          // v runs from this base to its partner; u is the outward radius.
          const cvx = dx / len;
          const cvy = dy / len;
          placeHelix(idx, partner, px, py, cvy, -cvx);
        } else if (partner === -1) {
          put(idx, px, py, tangent, false);
        }
      }
      phi += sign * advance[s];
    }
  };

  // --- the exterior: a baseline, with helices standing up from it -------------
  let x = 0;
  for (let k = 0; k < n; k++) {
    const p = pairs[k];
    if (p > k) {
      placeHelix(k, p, x, 0, 0, -1);
      x += H + W * EXTERIOR_GAP;
      k = p;
    } else {
      put(k, x, 0, 0, false);
      x += W;
    }
  }

  const bases = placed.filter((b): b is PlacedBase => b !== undefined);
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const b of bases) {
    for (const [lx, ly] of cellCorners(m)) {
      const rad = (b.angle * Math.PI) / 180;
      const c = Math.cos(rad);
      const s = Math.sin(rad);
      const dx = lx - W / 2;
      const dy = ly - H / 2;
      const wx = b.cx + dx * c - dy * s;
      const wy = b.cy + dx * s + dy * c;
      if (wx < minX) minX = wx;
      if (wy < minY) minY = wy;
      if (wx > maxX) maxX = wx;
      if (wy > maxY) maxY = wy;
    }
  }
  if (bases.length === 0) return { bases, minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { bases, minX, minY, maxX, maxY };
}

/** The cell's extreme corners, including room for a tooth on either edge. */
function cellCorners(m: GlyphMetrics): Array<[number, number]> {
  return [
    [0, -m.amp],
    [m.width, -m.amp],
    [m.width, m.height + m.amp],
    [0, m.height + m.amp],
  ];
}

/**
 * The SVG transform for a placed base: move to its centre, turn the cell frame,
 * step back to the cell's local origin, and — for a 3' strand — turn it over.
 */
export function placedBaseTransform(b: PlacedBase, m: GlyphMetrics): string {
  const base = `translate(${b.cx} ${b.cy}) rotate(${b.angle}) translate(${-m.width / 2} ${-m.height / 2})`;
  return b.turned ? `${base} rotate(180 ${m.width / 2} ${m.height / 2})` : base;
}

/**
 * Pairs of bases whose centres are closer than `tol` without being neighbours —
 * i.e. branches that have collided. The layout does no relaxation, so a caller
 * should surface this rather than present a tangled drawing as fact.
 */
export function overlappingPairs(layout: FoldLayout, tol: number): Array<[number, number]> {
  const hits: Array<[number, number]> = [];
  const { bases } = layout;
  for (let a = 0; a < bases.length; a++) {
    for (let b = a + 1; b < bases.length; b++) {
      const A = bases[a];
      const B = bases[b];
      if (Math.abs(A.index - B.index) <= 1) continue;
      if (A.partner === B.index) continue;
      if (Math.hypot(A.cx - B.cx, A.cy - B.cy) < tol) hits.push([A.index, B.index]);
    }
  }
  return hits;
}
