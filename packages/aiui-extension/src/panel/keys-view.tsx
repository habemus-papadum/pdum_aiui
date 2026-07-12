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
/* The CAPS STRIP is the command bar: visible whenever a turn is open (the
   panel's primary surface — every act has a cap, lit when engaged). Bigger
   than the overlay's page version: this is the panel's main affordance, not a
   corner cheat sheet. */
.keys-bar { margin: 0 0.125rem 0.5rem; }
.keys-bar[hidden] { display: none; }
.keys-bar .mm-cheat-wrap { display: block; }
.keys-bar .mm-cheat {
  max-width: 100%; width: 100%; margin: 0; box-sizing: border-box;
  background: var(--surface-2); border-color: var(--border-2);
  gap: 0.375rem; padding: 0.375rem 0.5rem; border-radius: 10px;
}
.keys-bar .mm-keycap {
  width: 2.25rem; height: 2rem; border-radius: 8px; border-width: 2px;
}
.keys-bar .mm-keyicon { font-size: 1.125rem; }
/* The lit ring: 2px and inset-free reads clean at this size (1px hairlines
   looked jagged on the emoji caps — reported live 2026-07-12). */
.keys-bar .mm-keycap.active {
  border-color: var(--ok); background: var(--ok-bg);
  box-shadow: 0 0 0 1px var(--ok-border);
}
.keys-bar .mm-cheat-tip { font-size: 0.75rem; padding: 0.25rem 0.625rem; }

/* The KEYMAP popup: covers the TOP of the panel (the caps and transcript live
   there — a bottom sheet fought them), two columns, larger type. ✕/Esc/? exit. */
.keys-island {
  position: fixed; left: 0.625rem; right: 0.625rem; top: 0.625rem; z-index: 70;
  max-height: 80vh; overflow: auto;
  background: var(--surface); border: 1px solid var(--border-2); border-radius: 10px;
  box-shadow: 0 0.75rem 2rem rgba(0, 0, 0, 0.6); padding: 0.625rem 0.75rem;
}
.keys-island[hidden] { display: none; }
.keys-head {
  display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem;
  font: 600 0.8125rem ui-sans-serif, system-ui, sans-serif; color: var(--text-2);
}
.keys-head .keys-x {
  margin-left: auto; background: none; border: none; color: var(--text-2);
  cursor: pointer; font-size: 0.875rem; padding: 0;
}
.keys-island .mm-keymap-help {
  height: auto; max-height: none; overflow: visible; margin: 0;
  columns: 2; column-gap: 1rem; column-fill: balance;
  font-size: 0.8125rem;
}
.keys-island .mm-help-section { break-inside: avoid; margin-bottom: 0.75rem; }
.keys-island .mm-help-row, .keys-island .mm-help-title { font-size: 0.8125rem; }
.keys-blip {
  font: 0.75rem ui-monospace, monospace; color: var(--warn);
  margin: 0.375rem 0 0;
}
`;

export interface KeysIsland {
  /** The in-turn command bar (the live keycaps). Sits inline in the panel. */
  readonly barRoot: HTMLElement;
  /** The help table's popup (?). A fixed, dismissible overlay. */
  readonly popupRoot: HTMLElement;
  /** Re-assert the bar, the popup's visibility, and the blip line. */
  sync(state: LeaderState, helpOpen: boolean, blip: string | undefined): void;
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

  // The command bar: caps + the swallowed-key line, inline in the panel.
  const barRoot = document.createElement("div");
  barRoot.className = "keys-bar";
  barRoot.hidden = true;
  barRoot.append(cheat.root, blipLine);

  // The help table's popup.
  const head = document.createElement("div");
  head.className = "keys-head";
  const title = document.createElement("span");
  title.textContent = "keymap";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "keys-x";
  close.textContent = "✕";
  close.addEventListener("click", onClose);
  head.append(title, close);

  const popupRoot = document.createElement("div");
  popupRoot.className = "keys-island";
  popupRoot.hidden = true;
  popupRoot.append(head, help.root);
  help.root.hidden = false; // the popup IS the help

  return {
    barRoot,
    popupRoot,
    sync(state, helpOpen, blip) {
      const inTurn = state.phase === "turn";
      barRoot.hidden = !inTurn;
      cheat.update(leaderHints(state), inTurn);
      popupRoot.hidden = !helpOpen;
      blipLine.hidden = blip === undefined;
      blipLine.textContent = blip === undefined ? "" : `× ${blip} — not a key here`;
    },
  };
}
