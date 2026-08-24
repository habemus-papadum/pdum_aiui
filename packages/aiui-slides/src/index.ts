/**
 * @habemus-papadum/aiui-slides — the slides framework: a deck of
 * viewport-sized slides, moved one FRAME at a time, as an ordinary aiui app.
 *
 * The shape (docs/proposals/slides.md is the decided contract, scenes
 * addendum included):
 *
 *  - **Slides are data** ({@link SlideDef}[]) and **the current frame is a
 *    pair of controls** ({@link createDeckModel}: `slide` + scene `step`) —
 *    durable, agent-drivable ("next" by voice through the derived tools),
 *    reported like any control. A slide declares `steps: n` to play n
 *    additive scenes inside itself before the deck moves on.
 *  - **Every input means one frame.** {@link Deck} interprets wheel and
 *    touch through pure intent machines (gestures.ts — one flick, notch, or
 *    finger-down = one step), and keyboard, cue, dots, and agent verbs
 *    dispatch the same unit — nothing can blow past an unplayed scene.
 *    Slides ride a translated track with a CSS glide (no native scroll);
 *    scenes are CSS state flips ({@link Step} cans the additive idiom over
 *    `useSlide().step()`).
 *  - **The chrome**: the bobbing {@link ScrollCue} (immediate on the title
 *    frame, back after 10 s of rest, pointing wherever a step remains), the
 *    {@link StepDots} scene-position dots, the {@link DeckNav} widget (a
 *    keyboard is never assumed; taps execute through the live keymap so
 *    widget and keys cannot drift), the {@link DeckHud} overview grid
 *    (slide-grained on purpose — scenes are a slide's interior), and the
 *    modal-kit key layers (keys.ts).
 *  - **URL binding** (path-binding.ts): slide ↔ pathname tail over aiui-viz's
 *    shared pathname signal — deep-linkable at every moment, replaceState so
 *    history stays sane, composing with a shell router that keys on the head.
 *    Slide-grained, like the HUD.
 *  - **{@link Lens}** — levels of detail for any page, deck or not: inline
 *    trigger → hover peek → interactive detail overlay, all in the page's
 *    own reactive graph.
 *
 * Default styling is the opt-in `./styles.css` (token-overridable
 * `aiui-deck-*` / `aiui-lens-*` classes). The reference deck is
 * demos/gear-talk.
 */

export { Deck } from "./deck";
export { type SlideHandle, useSlide } from "./deck-context";
export { DeckNav } from "./deck-nav";
export {
  createTouchIntent,
  createWheelIntent,
  type GestureStep,
  type TouchIntent,
  type TouchIntentOptions,
  type WheelIntent,
  type WheelIntentOptions,
} from "./gestures";
export { DeckHud } from "./hud";
export { type DeckCommand, type DeckKeyState, deckKeyLayers } from "./keys";
export { Lens, LensLayer } from "./lens";
export { createDeckModel, type DeckFrame, type DeckModel } from "./model";
export { bindDeckToPath, deckBase, pathForSlide, slideFromPath } from "./path-binding";
export { ScrollCue } from "./scroll-cue";
export { Step } from "./step";
export { StepDots } from "./step-dots";
export type { SlideDef } from "./types";
