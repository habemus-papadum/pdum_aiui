/**
 * tokens.ts — token estimation as a service of the core: an estimator is a
 * pure, named function pair (text, image), and the built-in default is
 * deliberately generic and a little conservative, so a budget decided against
 * it holds for the models this repository talks to without being tuned to
 * any one tokenizer. Every decision that used an estimator records its
 * identity; the default is part of the compiler, so replaying a record needs
 * nothing supplied. A host that knows its model's tokenizer passes its own
 * estimator, and must pass the same one when replaying.
 */

import type { Asset } from "./model.ts";

export type EstimatorIdentity = Readonly<{ name: string; version: string }>;

export interface TokenEstimator {
  readonly identity: EstimatorIdentity;
  /** Tokens for a text part. Must be deterministic and never negative. */
  text(text: string): number;
  /** Tokens for an image part, from its descriptor alone (no bytes). */
  image(asset: Asset): number;
}

/** OpenAI's documented scaling before tiling: fit 2048², then the short side to 768. */
function scaled(width: number, height: number): [number, number] {
  let w = width;
  let h = height;
  const long = Math.max(w, h);
  if (long > 2048) {
    w = (w * 2048) / long;
    h = (h * 2048) / long;
  }
  const short = Math.min(w, h);
  if (short > 768) {
    w = (w * 768) / short;
    h = (h * 768) / short;
  }
  return [w, h];
}

/**
 * The built-in default. Text: one token per 3.5 characters (English prose
 * runs nearer 4; numbers, code and markup tokenize denser, so 3.5 leans safe
 * without doubling). Images: the larger of two published rules — OpenAI's
 * tiles (85 + 170 per 512² tile after its scaling) and Anthropic's pixels
 * divided by 750 — on the scaled size; an image whose size is unknown is
 * taken as 1024 by 1024.
 */
export const CONSERVATIVE_ESTIMATOR: TokenEstimator = Object.freeze({
  identity: Object.freeze({ name: "aiui-prompts/conservative", version: "1" }),
  text: (text: string) => Math.ceil(text.length / 3.5),
  image: (asset: Asset) => {
    const [w, h] = scaled(asset.width ?? 1024, asset.height ?? 1024);
    const tiles = Math.ceil(w / 512) * Math.ceil(h / 512);
    return Math.max(85 + 170 * tiles, Math.ceil((w * h) / 750));
  },
});

/** The estimate for a run of compiled parts (text and images), under an estimator. */
export function estimateParts(
  parts: readonly Readonly<{ type: "text"; text: string } | { type: "image"; asset: Asset }>[],
  estimator: TokenEstimator = CONSERVATIVE_ESTIMATOR,
): number {
  let total = 0;
  for (const part of parts) {
    const value = part.type === "text" ? estimator.text(part.text) : estimator.image(part.asset);
    if (!Number.isFinite(value) || value < 0)
      throw new TypeError(`Estimator ${estimator.identity.name} returned an invalid count.`);
    total += value;
  }
  return total;
}
