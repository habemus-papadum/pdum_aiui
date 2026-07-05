/**
 * The keymap — the minimalism under test. Everything is reachable with one
 * hand and no chords:
 *
 *   `      arm / disarm the overlay (also the ✳ button)
 *   Space  talk — hold-to-talk or toggle, per settings.talkMode
 *   S      hold + drag a rect = region screenshot; tap = viewport shot
 *   C      clear ink
 *   E      enter/exit correct mode (the meta layer)
 *   Enter  send — finalize the thread
 *   Esc    step out one level (correct → ink → cancel thread → disarm)
 *
 * The decision logic is pure ({@link keyCommand}) so the design is unit-
 * testable; installKeymap() is the thin DOM binding around it.
 */

export interface KeyState {
  armed: boolean;
  mode: "ink" | "correct";
  talking: boolean;
  talkMode: "hold" | "toggle";
  /** True when focus is in a text input — keys must not fire. */
  typing: boolean;
}

export type KeyCommand =
  | { cmd: "arm-toggle" }
  | { cmd: "talk-start" }
  | { cmd: "talk-end" }
  | { cmd: "shoot-arm" } // S down: next drag is a shot; S up without drag = viewport shot
  | { cmd: "shoot-release" }
  | { cmd: "ink-clear" }
  | { cmd: "correct-toggle" }
  | { cmd: "send" }
  | { cmd: "step-out" };

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

  switch (key) {
    case " ":
      if (state.talkMode === "hold") {
        if (phase === "down" && !repeat && !state.talking) {
          return { cmd: "talk-start" };
        }
        if (phase === "up" && state.talking) {
          return { cmd: "talk-end" };
        }
        // Swallow repeats so the page never scrolls while armed.
        return state.talking && phase === "down" ? { cmd: "talk-start" } : undefined;
      }
      if (phase === "down" && !repeat) {
        return state.talking ? { cmd: "talk-end" } : { cmd: "talk-start" };
      }
      return undefined;
    case "s":
    case "S":
      if (phase === "down" && !repeat) {
        return { cmd: "shoot-arm" };
      }
      if (phase === "up") {
        return { cmd: "shoot-release" };
      }
      return undefined;
    case "c":
    case "C":
      return phase === "down" && !repeat ? { cmd: "ink-clear" } : undefined;
    case "e":
    case "E":
      return phase === "down" && !repeat ? { cmd: "correct-toggle" } : undefined;
    case "Enter":
      return phase === "down" && !repeat ? { cmd: "send" } : undefined;
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
