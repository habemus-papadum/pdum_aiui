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
.keys-island { margin: 0 0.125rem 0.5rem; }
.keys-island .mm-cheat-wrap { display: block; }
.keys-island .mm-cheat {
  max-width: 100%; width: 100%; margin: 0; box-sizing: border-box;
  background: var(--surface-2); border-color: var(--border-2);
}
.keys-island .mm-keymap-help {
  height: auto; max-height: 18rem; column-width: 11rem; overflow-y: auto;
  margin-top: 0.375rem;
}
.keys-blip {
  font: 0.6875rem ui-monospace, monospace; color: var(--warn);
  margin: 0.25rem 0 0;
}
`;

export interface KeysIsland {
  readonly root: HTMLElement;
  /** Re-assert the caps, the help table, and the blip line. */
  sync(state: LeaderState, helpOpen: boolean, blip: string | undefined): void;
}

/** Build the keys island. Call OUTSIDE any effect (see the module doc). */
export function createKeysIsland(onKey: (key: string) => void): KeysIsland {
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

  const root = document.createElement("div");
  root.className = "keys-island";
  root.append(cheat.root, blipLine, help.root);

  return {
    root,
    sync(state, helpOpen, blip) {
      cheat.update(leaderHints(state), state.phase === "turn");
      help.root.hidden = !helpOpen || state.phase !== "turn";
      blipLine.hidden = blip === undefined;
      blipLine.textContent = blip === undefined ? "" : `× ${blip} — not a key here`;
    },
  };
}
