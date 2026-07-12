/**
 * The keyboard surfaces, panel-hosted (Phase C3-lite): the overlay's
 * **CheatSheet** (live keycaps for whatever is bound RIGHT NOW — emoji caps,
 * labels on hover, lit when engaged) and its **KeymapHelp** table (`?`), both
 * driven by the extension's OWN key layer (leader.ts) through the shared hint
 * machinery — so what the caps show and what the keys do are one table, by
 * construction, in both hosts. Tapping a cap synthesizes the real key through
 * the panel's resolver, so a mouse user drives the same grammar.
 *
 * IMPERATIVE ISLAND (see preview-pane's note): built and updated outside the
 * reactive graph — these classes own internal signals, and touching them from
 * inside an effect throws `[REACTIVE_WRITE_IN_OWNED_SCOPE]` in Solid 2.0.
 */
import {
  CHEAT_STYLES,
  CheatSheet,
  KEYMAP_HELP_STYLES,
  KeymapHelp,
} from "@habemus-papadum/aiui-dev-overlay/multimodal-ui";
import { type LeaderState, leaderHelp, leaderHints } from "./leader";

const STYLE_ID = "aiui-panel-keys-styles";

/** Panel geometry for the shared surfaces (the page versions float; ours sit). */
const KEYS_STYLES = `
${CHEAT_STYLES}
${KEYMAP_HELP_STYLES}
/* The keys popup: shown on ? (or the ❓ cap), dismissed by ?/Esc/the ✕.
   Never a permanent tenant of the panel — the transcript owns that space. */
.keys-island {
  position: fixed; left: 0.625rem; right: 0.625rem; bottom: 0.625rem; z-index: 70;
  background: var(--surface); border: 1px solid var(--border-2); border-radius: 10px;
  box-shadow: 0 0.5rem 1.5rem rgba(0, 0, 0, 0.5); padding: 0.5rem 0.625rem;
  max-height: 70vh; overflow: auto;
}
.keys-island[hidden] { display: none; }
.keys-head {
  display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.375rem;
  font: 0.6875rem ui-monospace, monospace; color: var(--muted);
}
.keys-head .keys-x {
  margin-left: auto; background: none; border: none; color: var(--text-2);
  cursor: pointer; font-size: 0.75rem; padding: 0;
}
.keys-island .mm-cheat-wrap { display: block; }
.keys-island .mm-cheat {
  max-width: 100%; width: 100%; margin: 0; box-sizing: border-box;
  background: var(--surface-2); border-color: var(--border-2);
}
.keys-island .mm-keymap-help {
  height: auto; max-height: 40vh; column-width: 11rem; overflow-y: auto;
  margin-top: 0.5rem;
}
.keys-blip {
  font: 0.6875rem ui-monospace, monospace; color: var(--warn);
  margin: 0.25rem 0 0;
}
`;

export interface KeysIsland {
  readonly root: HTMLElement;
  /** Re-assert the popup's visibility, its caps, and the blip line. */
  sync(state: LeaderState, open: boolean, blip: string | undefined): void;
}

/**
 * Build the keys popup. `onKey` fires a synthesized key through the panel's
 * resolver (cap taps); `onClose` is the ✕. Call OUTSIDE any effect.
 */
export function createKeysIsland(onKey: (key: string) => void, onClose: () => void): KeysIsland {
  if (document.getElementById(STYLE_ID) === null) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = KEYS_STYLES;
    document.head.append(style);
  }
  const cheat = new CheatSheet(onKey);
  const help = new KeymapHelp();
  help.render(leaderHelp()); // static: the table is generated from the stack
  help.root.hidden = true;

  const blipLine = document.createElement("div");
  blipLine.className = "keys-blip";
  blipLine.hidden = true;

  const head = document.createElement("div");
  head.className = "keys-head";
  const title = document.createElement("span");
  title.textContent = "keys";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "keys-x";
  close.textContent = "✕";
  close.addEventListener("click", onClose);
  head.append(title, close);

  const root = document.createElement("div");
  root.className = "keys-island";
  root.hidden = true;
  root.append(head, cheat.root, blipLine, help.root);
  help.root.hidden = false; // the popup IS the help; no nested toggle

  return {
    root,
    sync(state, open, blip) {
      root.hidden = !open;
      cheat.update(leaderHints(state), true);
      blipLine.hidden = blip === undefined;
      blipLine.textContent = blip === undefined ? "" : `× ${blip} — not a key here`;
    },
  };
}
