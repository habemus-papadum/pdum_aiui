/**
 * types.ts — the slide contract.
 *
 * Slides are DATA, not JSX introspection (the gallery router's "routes are
 * data" move, one level down): a deck is an ordered array of {@link SlideDef},
 * and everything else — the URL segments, the HUD grid, the nav counter, any
 * future overview — derives from the array. Strictly LINEAR by design: a
 * sequence, never a tree. A slide's *internal* structure (progressive
 * disclosure, a Lens, its own state machine) is its own business and invisible
 * to the deck.
 */
import type { Component } from "solid-js";

/** One slide of a deck. */
export interface SlideDef {
  /** URL segment + stable identity ("mesh" → /gear-talk/mesh). Kebab-case,
   * unique within the deck. */
  id: string;
  /** Human name: the slide's aria-label, its HUD caption, and its
   * PageBoundary name. */
  title: string;
  /** The slide itself — an ordinary Solid component, mounted for the deck's
   * whole life (slides are one scrolling document; park rAF work off-screen
   * via `useSlide().active`). */
  content: Component;
  /**
   * The HUD-grid thumbnail — the DemoCard discipline at slide scale: a CHEAP,
   * self-contained mini-view built from the pure model only (its own local
   * state, no durable graph, no workers), because the HUD mounts every
   * slide's preview at once. Omitted → a typographic tile (number + title).
   */
  preview?: Component;
}
