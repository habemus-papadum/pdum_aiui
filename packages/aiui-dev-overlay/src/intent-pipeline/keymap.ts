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
 *   T      enter/exit tweak mode (hand the pointer + keyboard back to the app)
 *   Enter  send — finalize the thread (in correct mode: done editing, back to ink)
 *   Esc    step out one level (correct → ink, tweak → ink, cancel thread, disarm)
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
 * (`aiui-viz/modal`): four declarative {@link KeyLayer}s — arm (backtick,
 * always live), the config strip (active while open, everything unclaimed
 * falls through), the tweak handover (active in tweak mode: only T and Esc
 * are claimed, the page keeps the rest), and the armed base — resolved
 * top-down by the kit's pure `resolveKey`, wrapped in {@link keyCommand} so
 * the decision stays one unit-testable function of (state, key, phase,
 * repeat). installKeymap() is the thin DOM binding around it.
 */
import {
  isTypingTarget,
  type KeyClaim,
  type KeyLayer,
  resolveKey,
} from "@habemus-papadum/aiui-viz/modal";
import type { IntentTier } from "./config";
import type { Mode } from "./types";

export { isTypingTarget };

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
  mode: Mode;
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
  /**
   * T: enter/exit tweak mode (§B.5) — hand the pointer and keyboard back to
   * the app mid-turn (adjust a slider, click a button, re-select text), then
   * resume composing the same thread. The engine mode flips ink ⇄ tweak.
   */
  | { cmd: "tweak-toggle" }
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

const command = (cmd: KeyCommand): KeyClaim<KeyCommand> => ({ command: cmd });

/** Fire once on keydown, pass repeats/keyup — the tiny keyboard's usual shape. */
const onPress = (cmd: KeyCommand) => (_state: KeyState, _key: string, repeat: boolean) =>
  repeat ? ("pass" as const) : command(cmd);

/** Backtick arms/disarms from anywhere — above every other layer. */
const armLayer: KeyLayer<KeyState, KeyCommand> = {
  name: "arm",
  bindings: [{ keys: ["`"], down: onPress({ cmd: "arm-toggle" }) }],
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
  active: (state) => state.armed && !!state.configOpen && state.mode !== "tweak",
  bindings: [
    {
      keys: TIER_BY_DIGIT.map((_, index) => String(index + 1)),
      down: (_state, key, repeat) =>
        repeat ? "pass" : command({ cmd: "config-tier", tier: TIER_BY_DIGIT[Number(key) - 1] }),
    },
    { keys: ["s", "S"], down: onPress({ cmd: "config-save" }) },
    { keys: ["r", "R"], down: onPress({ cmd: "config-reset" }) },
    { keys: ["g", "G"], down: onPress({ cmd: "config-advanced" }) },
    // Picking a rung already changed the mode — Enter (like Esc/K) just closes.
    { keys: ["Escape", "Enter", "k", "K"], down: onPress({ cmd: "config-close" }) },
  ],
  fallback: "pass",
};

/**
 * Tweak mode (§B.5) — the EXPLICIT handover. While the engine is in tweak
 * the page owns the keyboard: this layer claims ONLY T (resume composing)
 * and Esc (step out), and the strip/armed layers below deactivate on
 * `mode === "tweak"`, so Space, D, S, C, E, V, K, Enter, and the strip's
 * digits ALL fall through to the app — that handover is the whole point of
 * the mode; `isTypingTarget` guarding alone can't express it. The arm layer
 * above stays live: backtick still disarms from anywhere, tweak included.
 */
const tweakLayer: KeyLayer<KeyState, KeyCommand> = {
  name: "tweak",
  active: (state) => state.armed && state.mode === "tweak",
  bindings: [
    { keys: ["t", "T"], down: onPress({ cmd: "tweak-toggle" }) },
    { keys: ["Escape"], down: onPress({ cmd: "step-out" }) },
  ],
  fallback: "pass",
};

/** The armed base layer — the tiny keyboard itself (inert during tweak). */
const armedLayer: KeyLayer<KeyState, KeyCommand> = {
  name: "armed",
  active: (state) => state.armed && state.mode !== "tweak",
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
    },
    {
      // The region shot: arm the crosshair veil on the way down, disarm on the
      // way up. A drag that pointerup already completed just disarms; a drag
      // still in flight finishes on its own pointerup (see shot.ts).
      keys: ["d", "D"],
      down: onPress({ cmd: "shoot-arm" }),
      up: () => command({ cmd: "shoot-release" }),
    },
    // The whole-viewport shot: a single press, fired on keydown. No veil, no
    // hold, no keyup handling — so it can never race a drag the way the old
    // S-tap-vs-S-drag heuristic did (see the header note).
    { keys: ["s", "S"], down: onPress({ cmd: "shoot-viewport" }) },
    { keys: ["c", "C"], down: onPress({ cmd: "ink-clear" }) },
    { keys: ["e", "E"], down: onPress({ cmd: "correct-toggle" }) },
    {
      // The realtime submode's screen share. Only in ink mode (correct mode
      // owns the pointer/keys for text selection), fired on keydown. The
      // command always emits here — whether it *does* anything is gated on the
      // effective submode in the modality's dispatch (a live tier only), which
      // is where config is known; a non-live tier just shows a hint.
      keys: ["v", "V"],
      down: (state, _key, repeat) =>
        !repeat && state.mode === "ink" ? command({ cmd: "video-toggle" }) : "pass",
    },
    { keys: ["k", "K"], down: onPress({ cmd: "config-toggle" }) },
    {
      // Tweak mode's entrance (§B.5). Only from ink mode — correct mode owns
      // its own keys wholesale; once in tweak, the tweak layer above owns T.
      keys: ["t", "T"],
      down: (state, _key, repeat) =>
        !repeat && state.mode === "ink" ? command({ cmd: "tweak-toggle" }) : "pass",
    },
    {
      keys: ["Enter"],
      down: (state, _key, repeat) => {
        if (repeat) {
          return "pass";
        }
        // In correct mode Enter means "done editing — back to ink", NEVER
        // "send the turn": the user's hands are on Enter to commit edits, and
        // one stray press must not fire the whole prompt into the session.
        return command(state.mode === "correct" ? { cmd: "correct-toggle" } : { cmd: "send" });
      },
    },
    { keys: ["Escape"], down: onPress({ cmd: "step-out" }) },
  ],
  fallback: "pass",
};

/** Top-down: backtick above the strip above the tweak handover above the armed base. */
const KEY_STACK: readonly KeyLayer<KeyState, KeyCommand>[] = [
  armLayer,
  stripLayer,
  tweakLayer,
  armedLayer,
];

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
