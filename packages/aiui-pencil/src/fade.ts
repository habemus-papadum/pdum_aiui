/** Pure crossfade and hold/charge/pop appearance curves. */

/** Fraction of a stroke's life at full, unaltered opacity — nothing happens. */
export const INK_HOLD = 0.8;
/** Of the life AFTER the hold, the fraction spent charging before the pop. */
export const INK_CHARGE = 0.6;
/** Extra radius at the charge's end (+67.5%) and over the final pop (+75%). */
const CHARGE_STRETCH = 0.675;
const POP_STRETCH = 0.75;
/** How far the colour is pulled toward white at full charge (0..1). Slight, on purpose. */
export const CHARGE_GLOW = 0.55;

/** How a stroke should be painted right now. */
export interface FadeStyle {
  /** 0 means invisible; data retention is independent. */
  alpha: number;
  /** Multiplier on every dab's radius: the warp stretch. */
  widthScale: number;
  /** 0..1, how far toward white the stroke has heated. */
  glow: number;
  /** 0..1, expansion of the central opening during the late charge and pop. */
  hollow: number;
}

export const FULL_STYLE: FadeStyle = { alpha: 1, widthScale: 1, glow: 0, hollow: 0 };

/**
 * The stroke's appearance at `ageMs` into a `fadeMs` life. Pure, so the curve is
 * testable without a canvas. `fadeMs <= 0` is permanent ink: always full.
 *
 * Three phases, by fraction of life `p`:
 *  - `p < 0.8` — nothing. Opaque, unstretched, uncoloured.
 *  - the next 60% of what remains — the CHARGE. Still fully opaque: the tell is
 *    a thickening and a warming toward white, not a dimming.
 *  - the last 40% — the POP. `1 - pop²`, so most of the disappearance happens in
 *    the final instants, while the stroke stretches wider still.
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
  const opening = Math.max(0, (q - 0.35) / 0.65);
  return {
    alpha: Math.max(0, 1 - pop * pop),
    widthScale: 1 + CHARGE_STRETCH * charge + POP_STRETCH * pop,
    glow: charge,
    hollow: opening * opening * (3 - 2 * opening),
  };
}

/**
 * A gentle monotonic dissolve, without the hold, charge, or pop of fadeStyle.
 * Smoothstep softens both ends. Width and glow stay constant, so the baked
 * tile can be reused throughout; alpha is applied while compositing.
 */
export function crossfadeStyle(ageMs: number, fadeMs: number): FadeStyle {
  if (fadeMs <= 0) {
    return FULL_STYLE;
  }
  const t = Math.min(1, Math.max(0, ageMs / fadeMs));
  const s = t * t * (3 - 2 * t);
  return { alpha: 1 - s, widthScale: 1, glow: 0, hollow: 0 };
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
