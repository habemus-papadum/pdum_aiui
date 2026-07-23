/**
 * color.ts — wavelength → display color. The benches run at scaled-up
 * wavelengths (µm-scale, so the wave texture is visible on screen); for
 * display we map the bench's band onto the visible spectrum, violet at the
 * short end to red at the long end. The color is a *label* for λ, chosen for
 * legibility on the dark journal surface — not radiometry.
 */

export type Rgb = [number, number, number];

/** Approximate spectral color for u ∈ [0,1] (0 = 400 nm violet, 1 = 700 nm red),
 *  linear-ish RGB in [0,1], boosted for dark-background legibility. */
export function spectralRgb(u: number): Rgb {
  const w = 400 + 300 * Math.min(1, Math.max(0, u)); // pseudo-nm
  let r = 0;
  let g = 0;
  let b = 0;
  if (w < 440) {
    r = (440 - w) / 100;
    b = 1;
  } else if (w < 490) {
    g = (w - 440) / 50;
    b = 1;
  } else if (w < 510) {
    g = 1;
    b = (510 - w) / 20;
  } else if (w < 580) {
    r = (w - 510) / 70;
    g = 1;
  } else if (w < 645) {
    r = 1;
    g = (645 - w) / 65;
  } else {
    r = 1;
  }
  // gentle floor so every λ reads on near-black
  const lift = (c: number): number => 0.08 + 0.92 * c;
  return [lift(r), lift(g), lift(b)];
}

/** Display color for bench wavelength λ within [λmin, λmax]. */
export function waveColor(lambda: number, band: readonly [number, number]): Rgb {
  const u = (lambda - band[0]) / (band[1] - band[0]);
  return spectralRgb(u);
}

/** CSS string form. */
export function waveColorCss(lambda: number, band: readonly [number, number]): string {
  const [r, g, b] = waveColor(lambda, band);
  return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
}
