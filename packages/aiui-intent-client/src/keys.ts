/**
 * keys.ts — the in-turn grammar, on the modal kit's layered resolver. The
 * rows are the old panel's hard-won `leader.ts` grammar (salvage list:
 * "grammar rows and tests — regenerate the plumbing from the engine spec");
 * the plumbing is new: every binding resolves to an ENGINE COMMAND, so keys,
 * caps, agent writes, and tests are one vocabulary with one writer.
 *
 * The layer's `fallback: "swallow"` is the in-turn claim: while composing,
 * no key reaches the page. `keyVerdict` distinguishes a swallowed TYPO
 * (blip-worthy) from deliberate swallows (repeats, modifiers, keyups), so
 * unknown in-turn keys blip + swallow — never exit, never leak (decided).
 */

import {
  type EngineState,
  type KeyClaim,
  type KeyLayer,
  keyHints,
  resolveKey,
} from "@habemus-papadum/aiui-viz/modal";

/** Keys that must never blip when swallowed (chords in progress). */
const MODIFIER_KEYS = new Set([
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "CapsLock",
  "NumLock",
  "ScrollLock",
  "AltGraph",
  "Fn",
  "Dead",
]);

const command = (name: string): KeyClaim<string> => ({ command: name });

/** Fire on each distinct press; repeats are swallowed silently. */
const onPress =
  (name: string) =>
  (_state: EngineState, _key: string, repeat: boolean): KeyClaim<string> =>
    repeat ? "swallow" : command(name);

/** The one in-turn layer (sub-layers — a config strip — slot above later). */
export const turnLayer: KeyLayer<EngineState, string> = {
  name: "turn",
  active: (state) => state.phase === "turn",
  bindings: [
    {
      keys: ["i", "I"],
      down: onPress("ink"),
      hint: (s) => ({
        key: "i",
        label: s.ink ? "ink off" : "ink",
        icon: "✏️",
        active: s.ink === true,
      }),
    },
    {
      keys: ["s", "S"],
      down: onPress("shot"),
      hint: { key: "s", label: "shot", icon: "🖼" },
    },
    {
      keys: ["a", "A"],
      down: onPress("selection"),
      hint: { key: "a", label: "add selection", icon: "📋" },
    },
    {
      keys: ["c", "C"],
      down: (state, _key, repeat) => (!repeat && state.ink === true ? command("clear") : "swallow"),
      hint: (s) => (s.ink === true ? { key: "c", label: "clear ink", icon: "🧹" } : undefined),
    },
    {
      keys: ["t", "T"],
      down: onPress("tweak"),
      hint: { key: "t", label: "tweak the page", icon: "🔧" },
    },
    {
      keys: [" "],
      down: onPress("talkPress"),
      up: () => command("talkRelease"),
      hint: (s) => ({
        key: "␣",
        label: "talk (hold)",
        icon: "🎙",
        active: s.talk === "hold",
      }),
    },
    {
      keys: ["h", "H"],
      down: onPress("handsFree"),
      hint: (s) => ({
        key: "h",
        label: s.talk === "handsFree" ? "stop hands-free" : "hands-free talk",
        icon: "🎧",
        active: s.talk === "handsFree",
      }),
    },
    {
      keys: ["m", "M"],
      down: (state, _key, repeat) =>
        !repeat && state.talk !== "off" ? command("mute") : "swallow",
      hint: (s) =>
        s.talk !== "off"
          ? {
              key: "m",
              label: s.micMuted ? "unmute" : "mute mic",
              icon: "🔇",
              active: s.micMuted === true,
            }
          : undefined,
    },
    {
      keys: ["v", "V"],
      down: onPress("video"),
      hint: (s) => ({
        key: "v",
        label: s.video ? "video off" : "video",
        icon: "🎥",
        active: s.video === true,
      }),
    },
    {
      keys: ["f", "F"],
      down: onPress("fpsMode"),
      hint: (s) => ({
        key: "f",
        label: s.videoMode === "smart" ? "constant rate" : "smart rate",
        icon: "⏱",
        active: s.videoMode === "constant",
      }),
    },
    {
      keys: ["Enter"],
      down: onPress("send"),
      hint: { key: "⏎", label: "send", icon: "📤" },
    },
    {
      keys: ["Escape"],
      down: onPress("escape"),
      hint: { key: "esc", label: "step out", icon: "✖" },
    },
    {
      keys: ["d", "D"],
      down: onPress("disarm"),
      hint: { key: "d", label: "disarm (abandon all)", icon: "💤", tone: "danger" },
    },
    {
      keys: ["?"],
      down: onPress("help"),
      hint: { key: "?", label: "help", icon: "❓" },
    },
  ],
  fallback: "swallow",
};

export const keyStack: readonly KeyLayer<EngineState, string>[] = [turnLayer];

/** The resolver's verdict, with the blip distinction made explicit. */
export type KeyVerdict =
  | { kind: "command"; command: string }
  | { kind: "blip"; key: string } // swallowed typo — flash it, change nothing
  | { kind: "swallow" } // deliberate silence (repeats, modifiers, keyups)
  | { kind: "pass" }; // no turn open — the page keeps the key

/** Map one key event through the stack. Pure — panel listener and forwarded
 * page keys both funnel through this. */
export function keyVerdict(
  state: EngineState,
  key: string,
  phase: "down" | "up",
  repeat: boolean,
): KeyVerdict {
  const claim = resolveKey(keyStack, state, key, phase, repeat);
  if (claim === "pass") {
    return { kind: "pass" };
  }
  if (claim !== "swallow") {
    return { kind: "command", command: claim.command };
  }
  // A swallow is a blip only for a distinct, unbound, non-modifier keydown.
  const bound = turnLayer.bindings.some((b) => b.keys.includes(key));
  if (phase === "down" && !repeat && !bound && !MODIFIER_KEYS.has(key)) {
    return { kind: "blip", key };
  }
  return { kind: "swallow" };
}

/** The displayed keymap IS the working keymap. */
export const hintsFor = (state: EngineState) => keyHints(keyStack, state);
