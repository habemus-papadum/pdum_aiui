/**
 * The keymap — the minimalism under test. Everything is reachable with one
 * hand and no chords:
 *
 *   `      arm / disarm the overlay (also the ✳ button)
 *   Space  talk — hold-to-talk or toggle, per settings.talkMode
 *   D      hold + drag a rect = region screenshot (release without a drag = nothing)
 *   S      whole-viewport screenshot (fires on press)
 *   C      clear ink
 *   J      enter/exit VS Code jump mode (double-click opens the jump picker)
 *   V      toggle screen share (realtime/live tiers only — the ~1fps ambient sampler)
 *   K      open/close the config strip (the quick-config layer)
 *   T      enter/exit tweak mode (hand the pointer + keyboard back to the app)
 *   H      toggle the help panel (the keymap, as a table)
 *   Enter  send — finalize the thread
 *   Esc    step out one level (tweak/vscode → ink, cancel thread, disarm)
 *
 * (E — correct mode — was removed in the append-only pivot: a correction is
 * spoken, new content the compiler reconciles; there is no transcript editor.)
 *
 * Every binding carries a display {@link KeyHint} (the kit's hint column), so
 * the always-on cheat sheet and the H help table are generated from the SAME
 * rows the resolver reads — see {@link intentKeyHints} / {@link keymapHelp}.
 *
 * The two screenshot gestures ride two keys ON PURPOSE. They were once both on
 * S — hold-and-drag for a region, a bare tap for the viewport — but a tap and a
 * *fast* drag are indistinguishable at keyup: on a quick drag the pointerup
 * finishes the region capture BEFORE the S keyup arrives, so at keyup the drag
 * already looks done and the "tapped without a drag" branch fired too — you got
 * BOTH the region shot and a whole-viewport one. Splitting the keys deletes that
 * heuristic outright: D means "arm the region veil" and never falls back to a
 * viewport shot, and S is a standalone viewport capture on keydown.
 *
 * K is deliberately the ONLY key config costs the main layer: everything else
 * (tier digits, save, reset, the advanced editor) lives inside the strip, where
 * the strip UI itself shows the bindings. While the strip is open its keys take
 * priority; every other key still means what it always means (Space talks), so
 * the strip is a layer, not a mode.
 *
 * The decision logic is the modal kit's layered resolution
 * (`aiui-viz/modal`): six declarative {@link KeyLayer}s — arm (backtick,
 * always live), the config strip (active while open, everything unclaimed
 * falls through), the jump picker (active while vscode mode's double-click
 * popup is open: arrows/digits/Enter/Esc drive it), the tweak handover
 * (active in tweak mode: only T and Esc are claimed, the page keeps the
 * rest), the vscode handover (same shape, claiming only J and Esc — the
 * double-click gesture is pointer-side), and the armed base — resolved
 * top-down by the kit's pure `resolveKey`, wrapped in {@link keyCommand} so
 * the decision stays one unit-testable function of (state, key, phase,
 * repeat). installKeymap() is the thin DOM binding around it.
 */
import {
  isTypingTarget,
  type KeyClaim,
  type KeyHint,
  type KeyLayer,
  keyHints,
  resolveKey,
} from "@habemus-papadum/aiui-viz/modal";
import type { IntentTier } from "./config";
import type { Mode } from "./types";

export { isTypingTarget };

/** The strip's digit row, cheapest tier first. `mock` is deliberately NOT
 * here — it is the test/offline preset, reachable through the advanced
 * editor (G), never the strip. */
export const TIER_BY_DIGIT: readonly IntentTier[] = ["rapid", "premium"];

export interface KeyState {
  armed: boolean;
  mode: Mode;
  talking: boolean;
  talkMode: "hold" | "toggle";
  /** True when focus is in a text input — keys must not fire. */
  typing: boolean;
  /** True while the quick-config strip is open (its keys take priority). */
  configOpen?: boolean;
  /** True while the jump picker is open (vscode mode's double-click popup). */
  pickerOpen?: boolean;
}

export type KeyCommand =
  | { cmd: "arm-toggle" }
  | { cmd: "talk-start" }
  | { cmd: "talk-end" }
  | { cmd: "shoot-arm" } // D down: arm the region veil — the next drag is the shot
  | { cmd: "shoot-release" } // D up: disarm the veil (a drag already in flight still finishes)
  | { cmd: "shoot-viewport" } // S: capture the whole viewport now — no veil, no hold
  | { cmd: "ink-clear" }
  /**
   * T: enter/exit tweak mode (§B.5) — hand the pointer and keyboard back to
   * the app mid-turn (adjust a slider, click a button, re-select text), then
   * resume composing the same thread. The engine mode flips ink ⇄ tweak.
   */
  | { cmd: "tweak-toggle" }
  /**
   * J: enter/exit VS Code jump mode — a tweak-shaped handover where
   * double-click opens the jump picker (the popup listing the stamped
   * element ancestors and containing cells at the click point). The engine
   * mode flips ink ⇄ vscode.
   */
  | { cmd: "vscode-toggle" }
  /** ↑/↓ while the jump picker is open: move its selection (wraps). */
  | { cmd: "jump-move"; delta: 1 | -1 }
  /**
   * Commit a jump-picker row: Enter commits the selection; a digit commits
   * the numbered row directly (`index` is 0-based over the openable rows).
   */
  | { cmd: "jump-commit"; index?: number }
  | { cmd: "jump-close" } // Esc while the picker is open: dismiss it, stay in jump mode
  | { cmd: "help-toggle" } // H: open/close the help panel (the keymap as a table)
  | { cmd: "video-toggle" } // V: toggle the realtime submode's screen share (dispatch gates on submode)
  | { cmd: "send" }
  | { cmd: "step-out" }
  | { cmd: "config-toggle" }
  | { cmd: "config-tier"; tier: IntentTier }
  | { cmd: "config-linter" }
  | { cmd: "config-save" }
  | { cmd: "config-reset" }
  | { cmd: "config-advanced" }
  | { cmd: "config-close" }
  /**
   * Claim the key (preventDefault) but do nothing. Exists for armed-Space
   * repeats: `talk-start` runs *async* mic acquisition before the engine
   * marks `talking`, so during that window held-Space repeats used to map to
   * nothing, go unprevented, and scroll the page — worst right after the
   * user first granted media permissions, when acquisition is slowest.
   */
  | { cmd: "swallow" };

const command = (cmd: KeyCommand): KeyClaim<KeyCommand> => ({ command: cmd });

/** Fire once on keydown, pass repeats/keyup — the tiny keyboard's usual shape. */
const onPress = (cmd: KeyCommand) => (_state: KeyState, _key: string, repeat: boolean) =>
  repeat ? ("pass" as const) : command(cmd);

/** Backtick arms/disarms from anywhere — above every other layer. */
const armLayer: KeyLayer<KeyState, KeyCommand> = {
  name: "arm",
  bindings: [
    {
      keys: ["`"],
      down: onPress({ cmd: "arm-toggle" }),
      hint: (state) => ({ key: "`", label: state.armed ? "disarm" : "arm", icon: "💪" }),
    },
  ],
  fallback: "pass",
};

/**
 * The strip's own keys, claimed only while it is open. Anything not claimed
 * here falls through to the normal armed layer below — except S, which the
 * strip claims for "save" (shadowing the viewport screenshot until it closes).
 * Because S now fires on keydown and the strip's save IS that keydown handler,
 * claiming it here is all it takes — there is no keyup to swallow anymore. (D
 * is deliberately NOT shadowed: the region veil stays reachable, and a D held
 * across the strip opening still disarms cleanly on its own keyup below.)
 */
const stripLayer: KeyLayer<KeyState, KeyCommand> = {
  name: "config-strip",
  active: (state) =>
    state.armed && !!state.configOpen && state.mode !== "tweak" && state.mode !== "vscode",
  bindings: [
    {
      keys: TIER_BY_DIGIT.map((_, index) => String(index + 1)),
      down: (_state, key, repeat) =>
        repeat ? "pass" : command({ cmd: "config-tier", tier: TIER_BY_DIGIT[Number(key) - 1] }),
      hint: { key: "1–2", label: "pick a tier", icon: "🎚" },
    },
    {
      keys: ["l", "L"],
      down: onPress({ cmd: "config-linter" }),
      hint: { key: "L", label: "linter: off → openai → gemini", icon: "💡" },
    },
    {
      keys: ["s", "S"],
      down: onPress({ cmd: "config-save" }),
      hint: { key: "S", label: "save for site", icon: "💾" },
    },
    {
      keys: ["r", "R"],
      down: onPress({ cmd: "config-reset" }),
      hint: { key: "R", label: "reset to file", icon: "↺" },
    },
    {
      keys: ["g", "G"],
      down: onPress({ cmd: "config-advanced" }),
      hint: { key: "G", label: "advanced editor", icon: "🧰" },
    },
    // Picking a rung already changed the mode — Enter (like Esc/K) just closes.
    {
      keys: ["Escape", "Enter", "k", "K"],
      down: onPress({ cmd: "config-close" }),
      hint: { key: "esc", label: "close", icon: "✕" },
    },
  ],
  fallback: "pass",
};

/**
 * Tweak mode (§B.5) — the EXPLICIT handover. While the engine is in tweak
 * the page owns the keyboard: this layer claims ONLY T (resume composing)
 * and Esc (step out), and the strip/armed layers below deactivate on
 * `mode === "tweak"`, so Space, D, S, C, E, J, V, K, Enter, and the strip's
 * digits ALL fall through to the app — that handover is the whole point of
 * the mode; `isTypingTarget` guarding alone can't express it. The arm layer
 * above stays live: backtick still disarms from anywhere, tweak included.
 */
const tweakLayer: KeyLayer<KeyState, KeyCommand> = {
  name: "tweak",
  active: (state) => state.armed && state.mode === "tweak",
  bindings: [
    {
      keys: ["t", "T"],
      down: onPress({ cmd: "tweak-toggle" }),
      hint: { key: "T", label: "resume the turn", icon: "🔧" },
    },
    { keys: ["Escape"], down: onPress({ cmd: "step-out" }), hint: { key: "esc", label: "resume" } },
  ],
  fallback: "pass",
};

/**
 * The jump picker's keys, claimed only while it is open (vscode mode's
 * double-click popup — jump-picker.tsx). A LAYER, not a mode, exactly like
 * the config strip: arrows/digits/Enter/Esc drive the picker, and every
 * unclaimed key falls through to the vscode handover below (so J still
 * exits jump mode — the reconciler closes the orphaned picker). Arrows
 * deliberately fire on repeats — holding ↓ scrolls the selection.
 */
const jumpPickerLayer: KeyLayer<KeyState, KeyCommand> = {
  name: "jump-picker",
  active: (state) => state.armed && state.mode === "vscode" && !!state.pickerOpen,
  bindings: [
    // One display row covers both arrows: ↑ claims silently, ↓ carries "↑↓".
    { keys: ["ArrowUp"], down: () => command({ cmd: "jump-move", delta: -1 }) },
    {
      keys: ["ArrowDown"],
      down: () => command({ cmd: "jump-move", delta: 1 }),
      hint: { key: "↑↓", label: "pick a row" },
    },
    {
      keys: ["1", "2", "3", "4", "5", "6", "7", "8", "9"],
      down: (_state, key, repeat) =>
        repeat ? "pass" : command({ cmd: "jump-commit", index: Number(key) - 1 }),
      hint: { key: "1–9", label: "jump to row" },
    },
    {
      keys: ["Enter"],
      down: onPress({ cmd: "jump-commit" }),
      hint: { key: "⏎", label: "open in VS Code", icon: "↗" },
    },
    {
      keys: ["Escape"],
      down: onPress({ cmd: "jump-close" }),
      hint: { key: "esc", label: "dismiss" },
    },
  ],
  fallback: "pass",
};

/**
 * VS Code jump mode — the same handover shape as tweak (the page keeps every
 * key not claimed here; the mode's own gesture is the pointer's double-click,
 * handled by the modality, not a key). Claimed: J (resume composing) and Esc
 * (step out). The arm layer above stays live, as always.
 */
const vscodeLayer: KeyLayer<KeyState, KeyCommand> = {
  name: "vscode",
  active: (state) => state.armed && state.mode === "vscode",
  bindings: [
    {
      keys: ["j", "J"],
      down: onPress({ cmd: "vscode-toggle" }),
      hint: { key: "J", label: "resume the turn", icon: "↗" },
    },
    // While the picker is open, its own Escape row shadows this one — the
    // hint resolver mirrors resolveKey's claim precedence.
    { keys: ["Escape"], down: onPress({ cmd: "step-out" }), hint: { key: "esc", label: "resume" } },
  ],
  fallback: "pass",
};

/** The armed base layer — the tiny keyboard itself (inert during tweak/vscode). */
const armedLayer: KeyLayer<KeyState, KeyCommand> = {
  name: "armed",
  active: (state) => state.armed && state.mode !== "tweak" && state.mode !== "vscode",
  bindings: [
    {
      keys: [" "],
      down: (state, _key, repeat) => {
        if (state.talkMode === "hold") {
          if (!repeat && !state.talking) {
            return command({ cmd: "talk-start" });
          }
          // Swallow every other armed-Space down (repeats — including the ones
          // that arrive while talk-start's mic acquisition is still in flight
          // and `talking` is not yet true) so the page never scrolls.
          return "swallow";
        }
        if (!repeat) {
          return command({ cmd: state.talking ? "talk-end" : "talk-start" });
        }
        // Toggle mode: repeats are equally scroll-y — swallow them too.
        return "swallow";
      },
      up: (state) =>
        // Release ALWAYS ends the hold — not just while `talking`. The
        // silence endpointer auto-splits a held Space into utterance
        // segments, so a release can land in the gap between one segment's
        // end and the next one's start; an unconditional talk-end is what
        // stops the auto-restart there (the modality's talkEnd is a no-op
        // when nothing is recording).
        state.talkMode === "hold" ? command({ cmd: "talk-end" }) : "pass",
      hint: (state) => ({
        key: "␣",
        label: state.talkMode === "hold" ? "hold to talk" : "talk on/off",
        icon: "🎙",
      }),
    },
    {
      // The region shot: arm the crosshair veil on the way down, disarm on the
      // way up. A drag that pointerup already completed just disarms; a drag
      // still in flight finishes on its own pointerup (see shot.ts).
      keys: ["d", "D"],
      down: onPress({ cmd: "shoot-arm" }),
      up: () => command({ cmd: "shoot-release" }),
      hint: { key: "D", label: "hold + drag: region shot", icon: "📸" },
    },
    // The whole-viewport shot: a single press, fired on keydown. No veil, no
    // hold, no keyup handling — so it can never race a drag the way the old
    // S-tap-vs-S-drag heuristic did (see the header note).
    {
      keys: ["s", "S"],
      down: onPress({ cmd: "shoot-viewport" }),
      hint: { key: "S", label: "viewport shot", icon: "🖼" },
    },
    {
      keys: ["c", "C"],
      down: onPress({ cmd: "ink-clear" }),
      hint: { key: "C", label: "clear ink", icon: "🧹" },
    },
    {
      // VS Code jump mode's entrance. Only from ink mode, exactly like tweak;
      // once in vscode mode, the vscode layer above owns J.
      keys: ["j", "J"],
      down: (state, _key, repeat) =>
        !repeat && state.mode === "ink" ? command({ cmd: "vscode-toggle" }) : "pass",
      hint: (state) =>
        state.mode === "ink" ? { key: "J", label: "jump to code", icon: "↗" } : undefined,
    },
    {
      // The realtime submode's screen share. Only in ink mode, fired on
      // keydown. The command always emits here — whether it *does* anything
      // is gated on the effective submode in the modality's dispatch (a live
      // tier only), which is where config is known; a non-live tier just
      // shows a hint.
      keys: ["v", "V"],
      down: (state, _key, repeat) =>
        !repeat && state.mode === "ink" ? command({ cmd: "video-toggle" }) : "pass",
      hint: (state) =>
        state.mode === "ink" ? { key: "V", label: "screen share (live)", icon: "🎥" } : undefined,
    },
    {
      keys: ["k", "K"],
      down: onPress({ cmd: "config-toggle" }),
      hint: { key: "K", label: "tiers & config", icon: "⚙️" },
    },
    {
      // Tweak mode's entrance (§B.5). Only from ink mode; once in tweak, the
      // tweak layer above owns T.
      keys: ["t", "T"],
      down: (state, _key, repeat) =>
        !repeat && state.mode === "ink" ? command({ cmd: "tweak-toggle" }) : "pass",
      hint: (state) =>
        state.mode === "ink" ? { key: "T", label: "tweak the app", icon: "🔧" } : undefined,
    },
    {
      // H — the universal help convention: the keymap you are reading, as a
      // panel. Live wherever the armed base is; the handover modes
      // deliberately leave H to the page.
      keys: ["h", "H"],
      down: onPress({ cmd: "help-toggle" }),
      hint: { key: "H", label: "help", icon: "❓" },
    },
    {
      keys: ["Enter"],
      down: onPress({ cmd: "send" }),
      hint: { key: "⏎", label: "send the turn", icon: "📤" },
    },
    {
      keys: ["Escape"],
      down: onPress({ cmd: "step-out" }),
      hint: { key: "esc", label: "step out" },
    },
  ],
  fallback: "pass",
};

/** Top-down: backtick above the strip above the picker above the tweak/vscode handovers above the armed base. */
const KEY_STACK: readonly KeyLayer<KeyState, KeyCommand>[] = [
  armLayer,
  stripLayer,
  jumpPickerLayer,
  tweakLayer,
  vscodeLayer,
  armedLayer,
];

/**
 * The live cheat-sheet rows for a state: the kit's {@link keyHints} over the
 * same stack {@link keyCommand} resolves through, so what the HUD shows and
 * what the keys do are one table. (The arm row displays backtick — a rebound
 * arming key is the modality's concern; it relabels the row at render time.)
 */
export function intentKeyHints(state: KeyState): KeyHint[] {
  return keyHints(KEY_STACK, state);
}

/** One help-table section: a mode/layer, its one-line story, and its rows. */
export interface KeymapHelpSection {
  title: string;
  note: string;
  hints: KeyHint[];
}

/**
 * The whole keymap as help-table data, generated by running the REAL layer
 * stack against one representative state per mode/layer — the table can't
 * drift from the bindings. Meta-layer sections (the strip, the
 * picker) are diffed against their surrounding state, so each shows what it
 * *changes*, not ten repeated rows.
 */
export function keymapHelp(talkMode: "hold" | "toggle" = "hold"): KeymapHelpSection[] {
  const at = (partial: Partial<KeyState>): KeyState => ({
    armed: true,
    mode: "ink",
    talking: false,
    talkMode,
    typing: false,
    ...partial,
  });
  const rows = (partial: Partial<KeyState>): KeyHint[] => keyHints(KEY_STACK, at(partial));
  const minus = (all: KeyHint[], baseline: KeyHint[]): KeyHint[] =>
    all.filter((h) => !baseline.some((b) => b.key === h.key && b.label === h.label));
  const base = rows({});
  // Order is layout: the help renders as fixed-height columns, so the big
  // "armed" section leads the first column and the small ones pack after it.
  return [
    {
      title: "armed",
      note: "compose the turn: talk, drag to sketch, shoot — Enter sends it",
      hints: base,
    },
    {
      title: "off",
      note: "arm to start a turn (the ✳ button works too)",
      hints: rows({ armed: false }),
    },
    {
      title: "tweak mode",
      note: "T — the page has the pointer and keyboard; the turn stays open",
      hints: rows({ mode: "tweak" }),
    },
    {
      title: "VS Code jump mode",
      note: "J — double-click an element to pick a jump target",
      hints: rows({ mode: "vscode" }),
    },
    {
      title: "jump picker",
      note: "open after a double-click in jump mode",
      hints: minus(rows({ mode: "vscode", pickerOpen: true }), rows({ mode: "vscode" })),
    },
    {
      title: "config strip",
      note: "K — model tiers and quick config",
      hints: minus(rows({ configOpen: true }), base),
    },
  ];
}

/** Map one key event to a command, or undefined to let the page have it. */
export function keyCommand(
  state: KeyState,
  key: string,
  phase: "down" | "up",
  repeat: boolean,
): KeyCommand | undefined {
  if (state.typing) {
    return undefined;
  }
  const claim = resolveKey(KEY_STACK, state, key, phase, repeat);
  if (claim === "pass") {
    return undefined;
  }
  if (claim === "swallow") {
    return { cmd: "swallow" };
  }
  return claim.command;
}

/** Bind the pure keymap to the document; returns an uninstall function. */
export function installKeymap(
  getState: () => Omit<KeyState, "typing">,
  dispatch: (command: KeyCommand) => void,
): () => void {
  const handler = (phase: "down" | "up") => (event: KeyboardEvent) => {
    const typing = isTypingTarget(event);
    const command = keyCommand({ ...getState(), typing }, event.key, phase, event.repeat);
    if (command) {
      event.preventDefault();
      event.stopPropagation();
      // A talk-start on a held key repeats; dedupe here so dispatch stays clean.
      if (!(command.cmd === "talk-start" && getState().talking)) {
        dispatch(command);
      }
    }
  };
  const down = handler("down");
  const up = handler("up");
  document.addEventListener("keydown", down, true);
  document.addEventListener("keyup", up, true);
  return () => {
    document.removeEventListener("keydown", down, true);
    document.removeEventListener("keyup", up, true);
  };
}
