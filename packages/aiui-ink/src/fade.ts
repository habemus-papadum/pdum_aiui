/**
 * The vanishing curve — the overlay's graduated ink fade, now the package's
 * (unified in extension Phase C2a; the overlay's `multimodal/ink.ts` is an
 * adapter over this surface).
 *
 * A linear fade is the wrong shape for gesture ink: the stroke spends its
 * whole life visibly dying, so it looks *sick* from the moment it's drawn,
 * and the actual disappearance — the only moment worth noticing — is the
 * least visible part of it. This one does nothing at all until the end, then
 * announces itself: a brief charge (the stroke thickens and heats toward
 * white, still fully opaque), then a fast pop out of existence. A ship going
 * to warp.
 */

/** Fraction of a stroke's life at full, unaltered opacity — nothing happens. */
export const INK_HOLD = 0.8;
/** Of the life AFTER the hold, the fraction spent charging before the pop. */
export const INK_CHARGE = 0.6;
/** Peak extra line width: at the charge's end (+45%) and at the pop's (+95%). */
const CHARGE_STRETCH = 0.45;
const POP_STRETCH = 0.5;
/** How far the colour is pulled toward white at full charge (0..1). Slight, on purpose. */
export const CHARGE_GLOW = 0.55;

/** How a stroke should be painted right now. */
export interface FadeStyle {
  /** 0 means gone — the draw loop retires the stroke. */
  alpha: number;
  /** Multiplier on the stroke's line width: the warp stretch. */
  widthScale: number;
  /** 0..1, how far toward white the stroke has heated. */
  glow: number;
}

export const FULL_STYLE: FadeStyle = { alpha: 1, widthScale: 1, glow: 0 };

/**
 * The stroke's appearance at `ageMs` into a `fadeMs` life. Pure, so the curve
 * is testable without a canvas. `fadeMs <= 0` is permanent ink: always full.
 *
 * Three phases, by fraction of life `p`:
 *  - `p < 0.8` — nothing. Opaque, unstretched, uncoloured.
 *  - the next 60% of what remains — the CHARGE. Still fully opaque: the tell
 *    is a thickening and a warming toward white, not a dimming. (~0.7s at
 *    the 6s default.)
 *  - the last 40% — the POP. `1 - pop²`, so most of the disappearance happens
 *    in the final instants, while the stroke stretches wider still. (~0.5s.)
 */
export function fadeStyle(ageMs: number, fadeMs: number): FadeStyle {
  if (fadeMs <= 0) {
    return FULL_STYLE;
  }
  const p = ageMs / fadeMs;
  if (p < INK_HOLD) {
    return FULL_STYLE;
  }
  const q = Math.min(1, (p - INK_HOLD) / (1 - INK_HOLD));
  const charge = Math.min(1, q / INK_CHARGE);
  const pop = Math.max(0, (q - INK_CHARGE) / (1 - INK_CHARGE));
  return {
    alpha: Math.max(0, 1 - pop * pop),
    widthScale: 1 + CHARGE_STRETCH * charge + POP_STRETCH * pop,
    glow: charge,
  };
}

/** Pull a `#rgb`/`#rrggbb` colour toward white by `t` (0..1). Unparseable → unchanged. */
export function heat(color: string, t: number): string {
  if (t <= 0) {
    return color;
  }
  const hex = color.trim().replace("#", "");
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
  if (!/^[0-9a-f]{6}$/i.test(full)) {
    return color; // a named colour, rgb(), a gradient — leave it alone
  }
  const channel = (i: number): number => {
    const value = Number.parseInt(full.slice(i * 2, i * 2 + 2), 16);
    return Math.round(value + (255 - value) * t);
  };
  return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`;
}
