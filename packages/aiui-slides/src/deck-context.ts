/**
 * deck-context.ts — how a slide learns where it lives.
 *
 * The Deck provides each slide a handle: its index, the deck model, and an
 * `active()` accessor — pause-not-destroy at slide granularity, strictly
 * OPT-IN. Slides are one scrolling document and most content is event-driven
 * (costs nothing off-screen); a slide that runs continuous work (an rAF
 * animation) gates its loop on `active()` and parks itself off-screen, the
 * same discipline a SitePage's activate/deactivate applies one level up.
 *
 * This is a rendering-context exception to "no ambient scope": the deck model
 * itself is still passed explicitly everywhere; the context only tells a
 * slide component WHICH slot of the deck it occupies, which is genuinely the
 * renderer's knowledge (the same slide component could appear twice).
 */
import { createContext, useContext } from "solid-js";
import type { DeckModel } from "./model";

/** What a slide can know about its place in the deck. */
export interface SlideHandle {
  /** The deck this slide is mounted in. */
  deck: DeckModel;
  /** This slide's index (fixed per mount). */
  index: number;
  /** Is this slide the current one? Gate rAF loops on this. */
  active(): boolean;
  /** THIS slide's rendered scene step (reactive): 0 before the deck reaches
   * it, its full `steps` once passed, the live step while current. Scenes
   * read it additively — `step() >= k` flips scene k's CSS state, and the
   * transition plays forward or backward for free (`Step` cans the idiom). */
  step(): number;
}

/** Solid 2.0: the context object IS its provider component — the Deck
 * renders `<SlideContext value={handle}>` around each slide. */
export const SlideContext = createContext<SlideHandle>();

/** The mounted slide's handle. Default-less context: calling this outside a
 * `<Deck>` throws ContextNotFoundError — a slide component that calls it is
 * deck-aware by intent, so the loud failure is the right one. */
export function useSlide(): SlideHandle {
  return useContext(SlideContext);
}
