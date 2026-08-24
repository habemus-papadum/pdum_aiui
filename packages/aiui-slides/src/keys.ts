/**
 * keys.ts — the deck's keyboard as modal-kit DATA (aiui-viz/modal keys.ts):
 * one base layer for frame movement, one HUD layer that claims Escape while
 * the overview is open. Claim-or-pass is exhaustive by construction; typing
 * targets already yield inside `installKeys`.
 *
 * Movement is STEP-grained: next/prev mean one frame (a scene, or a slide
 * once the scenes are spent) — the same unit every gesture and the cue tap
 * dispatch, so a keyboard can never blow past an unplayed scene. First/last
 * jump to the deck's outer frames.
 *
 * Two deliberate choices:
 *
 *  - **Escape does not OPEN the HUD** (reveal.js does that). On the modal
 *    ladder Esc means dismiss, and overloading it to open would fight the
 *    Lens and any future mode. The overview key is `o`; the WIDGET is the
 *    primary affordance anyway — a keyboard is never assumed.
 *  - **The HUD layer passes the movement keys.** The HUD is a projection of
 *    the deck: arrows keep driving the deck while it is open, and the
 *    highlighted tile follows.
 *
 * The nav widget executes through this same table ({@link resolveKey} on a
 * binding's first key — the tapKey house pattern), and its labels come from
 * the bindings' hints, so the displayed keymap and the working keymap are one
 * table.
 */
import type { KeyLayer } from "@habemus-papadum/aiui-viz/modal";

/** Everything a binding may ask the deck to do. */
export type DeckCommand = "next" | "prev" | "first" | "last" | "toggle-hud" | "close-hud";

/** The keymap's view of the deck (see `installKeys`' getState). */
export interface DeckKeyState {
  hudOpen: boolean;
  /** At the very first frame — nothing behind. */
  atStart: boolean;
  /** At the very last frame — nothing ahead. */
  atEnd: boolean;
}

/** The deck's layer stack, top-down: HUD above base. */
export function deckKeyLayers(): readonly KeyLayer<DeckKeyState, DeckCommand>[] {
  return [
    {
      name: "deck-hud",
      active: (s) => s.hudOpen,
      fallback: "pass", // movement keys keep working under the overview
      bindings: [
        {
          keys: ["Escape"],
          down: () => ({ command: "close-hud" }),
          hint: { key: "esc", label: "close overview" },
        },
      ],
    },
    {
      name: "deck-base",
      fallback: "pass", // a deck is a page, not a blocking dialog
      bindings: [
        {
          // Space repeats are welcome: held-key advance is a feature here —
          // one frame per repeat, scenes included.
          keys: ["ArrowDown", "ArrowRight", "PageDown", " "],
          down: () => ({ command: "next" }),
          hint: (s) => (s.atEnd ? { key: "↓", label: "end" } : { key: "↓", label: "next" }),
        },
        {
          keys: ["ArrowUp", "ArrowLeft", "PageUp"],
          down: () => ({ command: "prev" }),
          hint: { key: "↑", label: "back" },
        },
        { keys: ["Home"], down: () => ({ command: "first" }) },
        { keys: ["End"], down: () => ({ command: "last" }) },
        {
          keys: ["o", "O"],
          down: () => ({ command: "toggle-hud" }),
          hint: (s) => ({ key: "o", label: "overview", active: s.hudOpen }),
        },
      ],
    },
  ];
}
