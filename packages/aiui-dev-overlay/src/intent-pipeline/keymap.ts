/**
 * The keymap — the minimalism under test. Everything is reachable with one
 * hand and no chords:
 *
 *   `      arm / disarm the overlay (also the ✳ button)
 *   Space  talk — hold-to-talk or toggle, per settings.talkMode
 *   D      hold + drag a rect = region screenshot (release without a drag = nothing)
 *   S      whole-viewport screenshot (fires on press)
 *   C      clear ink
 *   E      enter/exit correct mode (the meta layer)
 *   V      toggle screen share (realtime/live tiers only — the ~1fps ambient sampler)
 *   K      open/close the config strip (the quick-config layer)
 *   Enter  send — finalize the thread (in correct mode: done editing, back to ink)
 *   Esc    step out one level (correct → ink → cancel thread → disarm)
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
 * The decision logic is pure ({@link keyCommand}) so the design is unit-
 * testable; installKeymap() is the thin DOM binding around it.
 */
import type { IntentTier } from "./config";

/** The strip's digit row: 1..5, cheapest tier first (matches the tier ladder). */
export const TIER_BY_DIGIT: readonly IntentTier[] = [
  "mock",
  "standard",
  "rapid",
  "premium",
  "flagship",
  "live-gemini",
  "live-openai",
];

export interface KeyState {
  armed: boolean;
  mode: "ink" | "correct";
  talking: boolean;
  talkMode: "hold" | "toggle";
  /** True when focus is in a text input — keys must not fire. */
  typing: boolean;
  /** True while the quick-config strip is open (its keys take priority). */
  configOpen?: boolean;
}

export type KeyCommand =
  | { cmd: "arm-toggle" }
  | { cmd: "talk-start" }
  | { cmd: "talk-end" }
  | { cmd: "shoot-arm" } // D down: arm the region veil — the next drag is the shot
  | { cmd: "shoot-release" } // D up: disarm the veil (a drag already in flight still finishes)
  | { cmd: "shoot-viewport" } // S: capture the whole viewport now — no veil, no hold
  | { cmd: "ink-clear" }
  | { cmd: "correct-toggle" }
  | { cmd: "video-toggle" } // V: toggle the realtime submode's screen share (dispatch gates on submode)
  | { cmd: "send" }
  | { cmd: "step-out" }
  | { cmd: "config-toggle" }
  | { cmd: "config-tier"; tier: IntentTier }
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
  if (key === "`" && phase === "down" && !repeat) {
    return { cmd: "arm-toggle" };
  }
  if (!state.armed) {
    return undefined;
  }

  // The strip's own keys, checked first while it is open. Anything not claimed
  // here falls through to the normal armed keymap below — except S, which the
  // strip claims for "save" (shadowing the viewport screenshot until it closes).
  // Because S now fires on keydown and the strip's save IS that keydown handler,
  // claiming it here is all it takes — there is no keyup to swallow anymore. (D
  // is deliberately NOT shadowed: the region veil stays reachable, and a D held
  // across the strip opening still disarms cleanly on its own keyup below.)
  if (state.configOpen && phase === "down" && !repeat) {
    const digit = Number.parseInt(key, 10);
    if (digit >= 1 && digit <= TIER_BY_DIGIT.length) {
      return { cmd: "config-tier", tier: TIER_BY_DIGIT[digit - 1] };
    }
    switch (key) {
      case "s":
      case "S":
        return { cmd: "config-save" };
      case "r":
      case "R":
        return { cmd: "config-reset" };
      case "g":
      case "G":
        return { cmd: "config-advanced" };
      case "Escape":
      case "Enter": // picking a rung already changed the mode — Enter just closes
      case "k":
      case "K":
        return { cmd: "config-close" };
    }
  }
  if ((key === "k" || key === "K") && phase === "down" && !repeat) {
    return { cmd: "config-toggle" };
  }

  switch (key) {
    case " ":
      if (state.talkMode === "hold") {
        if (phase === "down" && !repeat && !state.talking) {
          return { cmd: "talk-start" };
        }
        if (phase === "up") {
          // Release ALWAYS ends the hold — not just while `talking`. The
          // silence endpointer auto-splits a held Space into utterance
          // segments, so a release can land in the gap between one segment's
          // end and the next one's start; an unconditional talk-end is what
          // stops the auto-restart there (the modality's talkEnd is a no-op
          // when nothing is recording).
          return { cmd: "talk-end" };
        }
        // Swallow every other armed-Space down (repeats — including the ones
        // that arrive while talk-start's mic acquisition is still in flight
        // and `talking` is not yet true) so the page never scrolls.
        return { cmd: "swallow" };
      }
      if (phase === "down" && !repeat) {
        return state.talking ? { cmd: "talk-end" } : { cmd: "talk-start" };
      }
      // Toggle mode: repeats are equally scroll-y — swallow them too.
      return phase === "down" ? { cmd: "swallow" } : undefined;
    case "d":
    case "D":
      // The region shot: arm the crosshair veil on the way down, disarm on the
      // way up. A drag that pointerup already completed just disarms; a drag
      // still in flight finishes on its own pointerup (see shot.ts).
      if (phase === "down" && !repeat) {
        return { cmd: "shoot-arm" };
      }
      if (phase === "up") {
        return { cmd: "shoot-release" };
      }
      return undefined;
    case "s":
    case "S":
      // The whole-viewport shot: a single press, fired on keydown. No veil, no
      // hold, no keyup handling — so it can never race a drag the way the old
      // S-tap-vs-S-drag heuristic did (see the header note).
      return phase === "down" && !repeat ? { cmd: "shoot-viewport" } : undefined;
    case "c":
    case "C":
      return phase === "down" && !repeat ? { cmd: "ink-clear" } : undefined;
    case "e":
    case "E":
      return phase === "down" && !repeat ? { cmd: "correct-toggle" } : undefined;
    case "v":
    case "V":
      // The realtime submode's screen share. Only in ink mode (correct mode
      // owns the pointer/keys for text selection), fired on keydown. The
      // command always emits here — whether it *does* anything is gated on the
      // effective submode in the modality's dispatch (a live tier only), which
      // is where config is known; a non-live tier just shows a hint.
      return phase === "down" && !repeat && state.mode === "ink"
        ? { cmd: "video-toggle" }
        : undefined;
    case "Enter":
      if (phase === "down" && !repeat) {
        // In correct mode Enter means "done editing — back to ink", NEVER
        // "send the turn": the user's hands are on Enter to commit edits, and
        // one stray press must not fire the whole prompt into the session.
        return state.mode === "correct" ? { cmd: "correct-toggle" } : { cmd: "send" };
      }
      return undefined;
    case "Escape":
      return phase === "down" && !repeat ? { cmd: "step-out" } : undefined;
    default:
      return undefined;
  }
}

/**
 * True when the key event is aimed at something text-editable, so the keymap
 * must not swallow it. Covers native inputs/textareas, `contenteditable`
 * (which is what most web editors — ProseMirror, Lexical, Quill, CodeMirror —
 * ultimately focus), ARIA textboxes, and, via composedPath, inputs hidden
 * inside shadow DOM (where event.target at the document is only the host).
 * Known hole: a widget that handles keys on a plain non-editable element;
 * nothing observable distinguishes it from the page. Editors inside iframes
 * are unreachable by this listener entirely, hence naturally safe.
 */
export function isTypingTarget(event: KeyboardEvent): boolean {
  const target = (event.composedPath?.()[0] ?? event.target) as HTMLElement | null;
  if (!target || typeof target.closest !== "function") {
    return false;
  }
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.isContentEditable ||
    target.closest('[contenteditable=""], [contenteditable="true"], [role="textbox"]') !== null
  );
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
