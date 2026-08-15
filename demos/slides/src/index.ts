/**
 * @habemus-papadum/aiui-slides — the slides framework: a deck of
 * viewport-sized, scroll-snapped slides as an ordinary aiui app.
 *
 * The shape (docs/proposals/slides.md is the decided contract):
 *
 *  - **Slides are data** ({@link SlideDef}[]) and **the current slide is a
 *    control** ({@link createDeckModel}) — durable, agent-drivable ("next
 *    slide" by voice through the derived tools), reported like any control.
 *  - **{@link Deck}** renders the scroll-snap column and the chrome: the
 *    bobbing {@link ScrollCue} on the title slide, the {@link DeckNav} widget
 *    (a keyboard is never assumed; taps execute through the live keymap so
 *    widget and keys cannot drift), the {@link DeckHud} overview grid (every
 *    slide's `preview` at a glance), and the modal-kit key layers (keys.ts).
 *  - **URL binding** (path-binding.ts): slide ↔ pathname tail over aiui-viz's
 *    shared pathname signal — deep-linkable at every moment, replaceState so
 *    history stays sane, composing with a shell router that keys on the head.
 *  - **{@link Lens}** — levels of detail for any page, deck or not: inline
 *    trigger → hover peek → interactive detail overlay, all in the page's
 *    own reactive graph.
 *
 * Default styling is the opt-in `./styles.css` (token-overridable
 * `aiui-deck-*` / `aiui-lens-*` classes). Internal to the pdum_aiui repo
 * while incubating; never published yet.
 */

export { Deck } from "./deck";
export { type SlideHandle, useSlide } from "./deck-context";
export { DeckNav } from "./deck-nav";
export { DeckHud } from "./hud";
export { type DeckCommand, type DeckKeyState, deckKeyLayers } from "./keys";
export { Lens } from "./lens";
export { createDeckModel, type DeckModel } from "./model";
export { bindDeckToPath, deckBase, pathForSlide, slideFromPath } from "./path-binding";
export { ScrollCue } from "./scroll-cue";
export type { SlideDef } from "./types";
