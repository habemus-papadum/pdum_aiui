/**
 * deck-nav.tsx — the navigation WIDGET: back/forward chevrons flanking a
 * "3 / 6" counter that opens the HUD. The chevrons move ONE FRAME (a scene,
 * or a slide once its scenes are spent — the same unit as every gesture);
 * the counter stays slide-grained, the deck's table-of-contents unit. This
 * is the primary affordance — a keyboard is never assumed — and it is wired
 * so it CANNOT drift from the keymap:
 *
 *  - a button executes by synthesizing its binding's first key through the
 *    same `resolveKey` stack real keydowns use (the tapKey house pattern —
 *    modal-kit keys.ts);
 *  - its tooltip comes from the binding's own hint (`keyHints`), so the
 *    displayed keymap and the working keymap are one table — and the widget
 *    doubles as the keyboard cheat sheet ("next slide (↓)").
 *
 * Styling is default-but-replaceable: `aiui-deck-nav*` classes, tokens with
 * fallbacks in styles.css; a design system overrides the custom properties or
 * ships its own sheet.
 */
import { type KeyHint, keyHints } from "@habemus-papadum/aiui-viz/modal";
import type { JSX } from "@solidjs/web";
import { type DeckKeyState, deckKeyLayers } from "./keys";
import type { DeckModel } from "./model";

const LAYERS = deckKeyLayers();

function Chevron(props: { dir: "up" | "down" }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <title>{props.dir === "up" ? "previous" : "next"}</title>
      <path
        d={props.dir === "up" ? "M6 15l6-6 6 6" : "M6 9l6 6 6-6"}
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

export function DeckNav(props: {
  model: DeckModel;
  state: () => DeckKeyState;
  /** Execute a key through the live resolver (the Deck owns dispatch). */
  tap: (key: string) => void;
}): JSX.Element {
  const hintFor = (tapKey: string): KeyHint | undefined =>
    keyHints(LAYERS, props.state()).find((h) => h.tapKey === tapKey);
  const titleFor = (tapKey: string, fallback: string): string => {
    const hint = hintFor(tapKey);
    return hint === undefined ? fallback : `${hint.label} (${hint.key})`;
  };
  const slide = (): number => props.model.slide.get();

  return (
    <nav class="aiui-deck-nav" aria-label="slide navigation">
      <button
        type="button"
        class="aiui-deck-nav-btn"
        disabled={props.model.atStart()}
        aria-label="one step back"
        title={titleFor("ArrowUp", "back")}
        onClick={() => props.tap("ArrowUp")}
      >
        <Chevron dir="up" />
      </button>
      <button
        type="button"
        class="aiui-deck-nav-count"
        aria-label="slide overview"
        aria-expanded={props.state().hudOpen ? "true" : "false"}
        title={titleFor("o", "overview")}
        onClick={() => props.tap("o")}
      >
        <span class="aiui-deck-nav-now">{slide() + 1}</span>
        <span class="aiui-deck-nav-sep">/</span>
        <span class="aiui-deck-nav-total">{props.model.count}</span>
      </button>
      <button
        type="button"
        class="aiui-deck-nav-btn"
        disabled={props.model.atEnd()}
        aria-label="one step forward"
        title={titleFor("ArrowDown", "next")}
        onClick={() => props.tap("ArrowDown")}
      >
        <Chevron dir="down" />
      </button>
    </nav>
  );
}
