/**
 * keys.ts — the in-turn grammar, on the modal kit's layered resolver. The
 * rows carry over the retired extension panel's hard-won `leader.ts` grammar
 * (git history: aiui-extension); the plumbing is new: every binding resolves
 * to an ENGINE COMMAND, so keys,
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
import { sink } from "./spec";

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

/** Fire only into a live SINK; with none the page keeps the key (`pass`) —
 * the armed layer's contribution rows (the pause-slice hoist). */
const onSinkPress =
  (name: string) =>
  (state: EngineState, _key: string, repeat: boolean): KeyClaim<string> =>
    sink(state) === undefined ? "pass" : repeat ? "swallow" : command(name);

/** The one in-turn layer (sub-layers — a config strip — slot above later). */
export const turnLayer: KeyLayer<EngineState, string> = {
  name: "turn",
  active: (state) => state.phase === "turn",
  bindings: [
    {
      keys: ["s", "S"],
      down: onPress("shot"),
      hint: { key: "s", label: "shot", icon: "🖼" },
    },
    {
      // 'a' = AREA (owner, 2026-07-16): TOGGLE the crosshair drag — rubber-band a
      // region for a cropped shot. `active` carries engagement; a completed drag
      // auto-exits. One of the four mutually-exclusive page-pointer tools.
      keys: ["a", "A"],
      down: onPress("region"),
      hint: (s) => ({ key: "a", label: "area shot", icon: "⛶", active: s.region === true }),
    },
    {
      // 'j' = JUMP (owner, 2026-07-16): TOGGLE the jump-to-editor pick on
      // aiui-instrumented pages — click an element, pick a row, VS Code opens.
      // A commit/cancel auto-exits; mutually exclusive with pencil/area.
      keys: ["j", "J"],
      down: onPress("jump"),
      hint: (s) => ({ key: "j", label: "jump to editor", icon: "🎯", active: s.jump === true }),
    },
    {
      keys: ["p", "P"],
      down: onPress("selection"),
      hint: { key: "p", label: "pull selection", icon: "📋" },
    },
    {
      // pencil: 'k' toggles markup MODE on/off (owner, 2026-07-16).
      // clear + vanish + fade live in the bar; vanish/fade are config controls.
      keys: ["k", "K"],
      down: onPress("pencil"),
      hint: (s) => ({
        key: "k",
        label: "pencil",
        icon: "🖊",
        active: s.pencil === true,
      }),
    },
    {
      keys: ["c", "C"],
      down: (state, _key, repeat) =>
        !repeat && state.pencil === true ? command("pencilClear") : "swallow",
      hint: (s) =>
        s.pencil === true ? { key: "c", label: "clear pencil", icon: "🧹" } : undefined,
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
        label: "hands-free talk",
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
          ? { key: "m", label: "mute mic", icon: "🔇", active: s.micMuted === true }
          : undefined,
    },
    {
      keys: ["v", "V"],
      down: onPress("video"),
      hint: (s) => ({ key: "v", label: "video", icon: "🎥", active: s.video === true }),
    },
    {
      keys: ["f", "F"],
      down: onPress("fpsMode"),
      hint: (s) => ({
        key: "f",
        label: "constant cadence",
        icon: "⏱",
        active: s.videoMode === "constant",
      }),
    },
    {
      // b = PAUSE (owner, 2026-07-30): toggle the collection pause. The whole
      // keyboard stays claimed while paused (a paused turn is still a turn),
      // so `b` resumes from anywhere — page or panel.
      keys: ["b", "B"],
      down: onPress("pause"),
      hint: (s) => ({ key: "b", label: "pause turn", icon: "⏸", active: s.paused === true }),
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

/**
 * The armed-level layer — the C0 split, empty on purpose. It sits BELOW the
 * turn layer with `fallback: "pass"`: while merely armed the page keeps its
 * whole keyboard (the retired "armed owns the events" doctrine stays
 * retired), and the tranche-C slices add armed-scope keys HERE as table rows
 * (C1 video, C2 pencil, C3 talk) instead of inventing new machinery. In a
 * turn it is unreachable by construction — the turn layer's swallow fallback
 * ends the walk first.
 */
export const armedLayer: KeyLayer<EngineState, string> = {
  name: "armed",
  // The armed grammar (C3′, owner 2026-07-25: "armed means the grammar is
  // live"): a FEW claimed keys, live on the panel document AND on the page
  // (the keyRouting claim asserts exactly this layer's live bound set —
  // claimedPageKeys below); everything unbound stays the page's. Escape is
  // deliberately NOT here: pages need Esc for their own modals — the panel's
  // local listener still steps the ladder.
  active: (state) => state.phase === "armed",
  bindings: [
    {
      // Enter advances the ladder: while armed it OPENS the turn (in a turn
      // it already sends) — the shortcut the turn cap's click was missing.
      keys: ["Enter"],
      down: onPress("turn"),
      hint: { key: "⏎", label: "open a turn", icon: "💬" },
    },
    {
      // C3′: hands-free is a standing mode — toggle it with no turn open
      // (nothing records until a consumer exists; a turn routes it).
      keys: ["h", "H"],
      down: onPress("handsFree"),
      hint: (s) => ({
        key: "h",
        label: "hands-free talk",
        icon: "🎧",
        active: s.talk === "handsFree",
      }),
    },
    {
      // C3′: jump is an EDITOR act — armed-scope like pencil.
      keys: ["j", "J"],
      down: onPress("jump"),
      hint: (s) => ({ key: "j", label: "jump to editor", icon: "🎯", active: s.jump === true }),
    },
    {
      // C2: the pencil rides armed — toggle markup with no turn open.
      keys: ["k", "K"],
      down: onPress("pencil"),
      hint: (s) => ({ key: "k", label: "pencil", icon: "🖊", active: s.pencil === true }),
    },
    {
      keys: ["c", "C"],
      down: (state, _key, repeat) =>
        !repeat && state.pencil === true ? command("pencilClear") : "pass",
      hint: (s) =>
        s.pencil === true ? { key: "c", label: "clear pencil", icon: "🧹" } : undefined,
    },
    // ── the hoisted contribution keys (the pause slice, owner 2026-07-30):
    // SINK-gated rows that `pass` with no sink, so while merely armed the
    // page keeps s/a/p and — critically — Space for scrolling, exactly as
    // C3′ promised (claimedPageKeys probes the real resolver, so none of
    // these are claimed page-side until a sink exists). Unreachable today —
    // the only sink is an unpaused TURN, where this layer is inactive — they
    // are the slice-2 seam: the day an armed-scope sink (the oracle) lands,
    // these rows go live with no new machinery. Hints mirror the gate. ─────
    {
      keys: ["s", "S"],
      down: onSinkPress("shot"),
      hint: (s) => (sink(s) !== undefined ? { key: "s", label: "shot", icon: "🖼" } : undefined),
    },
    {
      keys: ["a", "A"],
      down: onSinkPress("region"),
      hint: (s) =>
        sink(s) !== undefined
          ? { key: "a", label: "area shot", icon: "⛶", active: s.region === true }
          : undefined,
    },
    {
      keys: ["p", "P"],
      down: onSinkPress("selection"),
      hint: (s) =>
        sink(s) !== undefined ? { key: "p", label: "pull selection", icon: "📋" } : undefined,
    },
    {
      keys: [" "],
      down: onSinkPress("talkPress"),
      up: (state) => (sink(state) === undefined ? "pass" : command("talkRelease")),
      hint: (s) =>
        sink(s) !== undefined
          ? { key: "␣", label: "talk (hold)", icon: "🎙", active: s.talk === "hold" }
          : undefined,
    },
    {
      // Video is a standing source (C1) — its toggles ride armed too.
      keys: ["v", "V"],
      down: onPress("video"),
      hint: (s) => ({ key: "v", label: "video", icon: "🎥", active: s.video === true }),
    },
    {
      keys: ["f", "F"],
      down: onPress("fpsMode"),
      hint: (s) => ({
        key: "f",
        label: "constant cadence",
        icon: "⏱",
        active: s.videoMode === "constant",
      }),
    },
    {
      keys: ["d", "D"],
      down: onPress("disarm"),
      hint: { key: "d", label: "disarm", icon: "💤", tone: "danger" },
    },
  ],
  fallback: "pass",
};

/**
 * The page-side claim SET for the current state (the keyRouting claim's
 * payload — C3′): `"all"` whenever a swallow-fallback layer is active (a turn
 * claims the whole keyboard — unknown keys swallow+blip, unchanged contract);
 * otherwise exactly the keys the active pass-fallback layers would answer
 * for, probed through the real resolver so a state-gated binding (pencil's
 * `c`) is claimed only while it would act. Escape is NEVER claimed on the
 * page outside a turn (pages need it for their own modals — decided, C3′).
 */
export function claimedPageKeys(state: EngineState): "all" | string[] {
  const candidates = new Set<string>();
  for (const layer of keyStack) {
    if (layer.active && !layer.active(state)) {
      continue;
    }
    if (layer.fallback === "swallow") {
      return "all";
    }
    for (const binding of layer.bindings) {
      for (const key of binding.keys) {
        candidates.add(key);
      }
    }
  }
  return [...candidates].filter(
    (key) => key !== "Escape" && resolveKey(keyStack, state, key, "down", false) !== "pass",
  );
}

export const keyStack: readonly KeyLayer<EngineState, string>[] = [turnLayer, armedLayer];

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
  // "Bound" reads the whole ACTIVE stack, not one layer — an armed-scope
  // binding must not blip as a typo once the armed layer carries rows.
  const bound = keyStack.some(
    (layer) =>
      (layer.active === undefined || layer.active(state)) &&
      layer.bindings.some((b) => b.keys.includes(key)),
  );
  if (phase === "down" && !repeat && !bound && !MODIFIER_KEYS.has(key)) {
    return { kind: "blip", key };
  }
  return { kind: "swallow" };
}

/** The displayed keymap IS the working keymap. */
export const hintsFor = (state: EngineState) => keyHints(keyStack, state);
