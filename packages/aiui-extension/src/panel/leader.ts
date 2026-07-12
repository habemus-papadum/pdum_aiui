/**
 * The in-turn key grammar (proposal §13.6 — the extension interaction model).
 *
 * Capture is per-TURN: while a turn is open, aiui owns the page keyboard and
 * a single key picks an action:
 *
 *   i      ink mode on/off (pointer claim only — never touches the strokes)
 *   s      shot (whole viewport of the active tab)
 *   a      add selection (the explicit pull)
 *   c      clear ink (offered while ink mode is on; see PHASE-A.md gap 2)
 *   t      tweak — release ALL capture, turn stays open; ⌘B resumes
 *   d      disarm — abandon everything (turn, ink, standing tools)
 *   Enter  send the turn (you stay armed)
 *   Esc    cancel the turn (the ladder's rung; you stay armed)
 *
 * Outside a turn NOTHING here runs — armed is presence, not capture, and the
 * page keeps its keys (§13.6 divergence 6 applies only inside turns). ⌘B is
 * not in this table: it is the browser-global `chrome.commands` leader whose
 * state-dependent meaning the panel resolves — arm+turn / open a turn /
 * **grant this tab** (in-turn, idempotent — never cancels; that is Esc's job)
 * / resume from tweak. It must stay global because in tweak the page owns
 * every ordinary key and only the leader can reach us.
 *
 * Built on the modal kit (`aiui-viz/modal`) — same machinery as the overlay's
 * keymap, deliberately different grammar (the §13.6 divergence ledger). The
 * rules, all in {@link leaderKeyEvent} (pure — table-tested):
 *  - a bound key fires its action; the turn stays open (send/cancel/tweak/
 *    disarm change state via their actions, not via layer bookkeeping);
 *  - an unknown non-modifier key is swallowed + reported `ignored` (the pink
 *    miss-blip) — it NEVER leaks to the page and never ends anything;
 *  - modifier keys, repeats, and all keyups are swallowed silently;
 *  - while no turn is open everything passes — the page keeps its keys.
 *
 * The hint strip renders in the PANEL ONLY (the page carries no chrome but
 * ring + ink), from the same rows the resolver reads.
 */
// Font Awesome Free (CC BY 4.0) solid glyphs, bundled as raw SVG markup —
// monochrome, currentColor-tinted caps (the panel's visual language; color
// emoji read as stickers there). ?raw keeps them out of any font pipeline.
import faAsterisk from "@fortawesome/fontawesome-free/svgs/solid/asterisk.svg?raw";
import faBroom from "@fortawesome/fontawesome-free/svgs/solid/broom.svg?raw";
import faQuestion from "@fortawesome/fontawesome-free/svgs/solid/circle-question.svg?raw";
import faGauge from "@fortawesome/fontawesome-free/svgs/solid/gauge-high.svg?raw";
import faImage from "@fortawesome/fontawesome-free/svgs/solid/image.svg?raw";
import faMicrophone from "@fortawesome/fontawesome-free/svgs/solid/microphone.svg?raw";
import faMicLines from "@fortawesome/fontawesome-free/svgs/solid/microphone-lines.svg?raw";
import faMicSlash from "@fortawesome/fontawesome-free/svgs/solid/microphone-slash.svg?raw";
import faMoon from "@fortawesome/fontawesome-free/svgs/solid/moon.svg?raw";
import faPlane from "@fortawesome/fontawesome-free/svgs/solid/paper-plane.svg?raw";
import faPaste from "@fortawesome/fontawesome-free/svgs/solid/paste.svg?raw";
import faPen from "@fortawesome/fontawesome-free/svgs/solid/pen.svg?raw";
import faVideo from "@fortawesome/fontawesome-free/svgs/solid/video.svg?raw";
import faWrench from "@fortawesome/fontawesome-free/svgs/solid/wrench.svg?raw";
import faXmark from "@fortawesome/fontawesome-free/svgs/solid/xmark.svg?raw";
import type { KeymapHelpSection } from "@habemus-papadum/aiui-dev-overlay/intent-pipeline";
import {
  type KeyClaim,
  type KeyHint,
  type KeyLayer,
  keyHints,
  resolveKey,
} from "@habemus-papadum/aiui-viz/modal";

/** What the panel does when an in-turn key fires. */
export type LeaderAction =
  | "ink"
  | "shot"
  | "selection"
  | "clear"
  | "tweak"
  | "disarm"
  | "send"
  | "cancel"
  | "help"
  | "talkPress"
  | "talkRelease"
  | "handsFree"
  | "mute"
  | "video"
  | "fpsMode";

/** The §13.6 phases the grammar can see (disarmed = no grammar at all). */
export type LeaderPhase = "armed" | "turn" | "tweak";

/** The state the grammar reads — a snapshot of the panel's signals. */
export interface LeaderState {
  /** Where we are in the §13.6 machine. Keys resolve only in "turn". */
  phase: LeaderPhase;
  /** Ink mode is on (lights the `i` cap, offers `c`). */
  inkOn: boolean;
  /** The active tab reports a live selection (lights the `a` cap). */
  selectionPresent: boolean;
  /** The mic loop is listening (offers `m`; lights whichever cap started it). */
  talking: boolean;
  /** The listening loop was started by a Space HOLD (vs h hands-free). */
  holdTalk: boolean;
  /** The open talk window's mic is muted (lights the `m` cap). */
  micMuted: boolean;
  /** Video sampling is on (lights the `v` cap). */
  videoOn: boolean;
  /** Cadence is smart (interaction-gated); constant lights the `f` cap. */
  fpsSmart: boolean;
}

/** The resolver's verdict for one key event. */
export type LeaderEvent =
  | { kind: "action"; action: LeaderAction }
  | { kind: "ignored"; key: string } // swallowed typo — blip, nothing changes
  | { kind: "stay" } // swallowed silently (modifiers, repeats, keyups)
  | { kind: "pass" }; // no turn open — the page keeps the key

/** Modifier keys blip nothing — the leader chord's own keys included. */
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

const command = (action: LeaderAction): KeyClaim<LeaderAction> => ({ command: action });

/** Fire on each distinct press; repeats are swallowed silently. */
const onPress =
  (action: LeaderAction) =>
  (_state: LeaderState, _key: string, repeat: boolean): KeyClaim<LeaderAction> =>
    repeat ? "swallow" : command(action);

/**
 * The one layer. `fallback: "swallow"` is the in-turn claim: while composing,
 * no key reaches the page — {@link leaderKeyEvent} turns unbound swallows
 * into `ignored` blips (never an exit, never a leak).
 */
const turnLayer: KeyLayer<LeaderState, LeaderAction> = {
  name: "turn",
  active: (state) => state.phase === "turn",
  bindings: [
    {
      keys: ["i", "I"],
      down: onPress("ink"),
      hint: (state) => ({
        key: "i",
        label: state.inkOn ? "ink off" : "ink",
        icon: "✏️",
        iconSvg: faPen,
        active: state.inkOn,
      }),
    },
    {
      keys: ["s", "S"],
      down: onPress("shot"),
      hint: { key: "s", label: "shot", icon: "🖼", iconSvg: faImage },
    },
    {
      keys: ["a", "A"],
      down: onPress("selection"),
      hint: (state) => ({
        key: "a",
        label: "add selection",
        icon: "📋",
        iconSvg: faPaste,
        active: state.selectionPresent,
      }),
    },
    {
      // Clear the sketch (the overlay's C). Gated on ink mode for now — see
      // PHASE-A.md gap 2 (should offer whenever strokes exist).
      keys: ["c", "C"],
      down: (state, _key, repeat) => (!repeat && state.inkOn ? command("clear") : "swallow"),
      hint: (state) =>
        state.inkOn ? { key: "c", label: "clear ink", icon: "🧹", iconSvg: faBroom } : undefined,
    },
    {
      // Tweak: hand keyboard AND pointer back to the page, turn stays open.
      // Only ⌘B can resume (the page owns every ordinary key in tweak).
      keys: ["t", "T"],
      down: onPress("tweak"),
      hint: { key: "t", label: "tweak the page", icon: "🔧", iconSvg: faWrench },
    },
    {
      // Talk (C5): hold Space to talk — down starts the mic loop, up ends it
      // (the ONE keyup the grammar acts on; every other keyup is swallowed).
      keys: [" "],
      down: onPress("talkPress"),
      hint: (state) => ({
        key: "␣",
        label: "talk (hold)",
        icon: "🎙",
        iconSvg: faMicrophone,
        active: state.talking && state.holdTalk,
      }),
    },
    {
      keys: ["h", "H"],
      down: onPress("handsFree"),
      hint: (state) => ({
        key: "h",
        label: state.talking && !state.holdTalk ? "stop hands-free" : "hands-free talk",
        icon: "🎧",
        iconSvg: faMicLines,
        active: state.talking && !state.holdTalk,
      }),
    },
    {
      // Mute is only meaningful while a talk window is open.
      keys: ["m", "M"],
      down: (state, _key, repeat) => (!repeat && state.talking ? command("mute") : "swallow"),
      hint: (state) =>
        state.talking
          ? {
              key: "m",
              label: state.micMuted ? "unmute" : "mute mic",
              icon: "🔇",
              iconSvg: faMicSlash,
              active: state.micMuted,
            }
          : undefined,
    },
    {
      // Video sampling toggle — a mode button, exactly like hands-free talk.
      keys: ["v", "V"],
      down: onPress("video"),
      hint: (state) => ({
        key: "v",
        label: state.videoOn ? "video off" : "video",
        icon: "🎥",
        iconSvg: faVideo,
        active: state.videoOn,
      }),
    },
    {
      // Cadence: smart (interaction-gated) ↔ constant (the config slider).
      keys: ["f", "F"],
      down: onPress("fpsMode"),
      hint: (state) => ({
        key: "f",
        label: state.fpsSmart ? "constant rate" : "smart rate",
        icon: "⏱",
        iconSvg: faGauge,
        active: !state.fpsSmart,
      }),
    },
    {
      keys: ["Enter"],
      down: onPress("send"),
      hint: { key: "⏎", label: "send", icon: "📤", iconSvg: faPlane },
    },
    {
      // The ladder's in-turn rung: cancel the turn, stay armed. (Sub-layers —
      // strip, picker — slot above this when they arrive in Phase C.)
      keys: ["Escape"],
      down: onPress("cancel"),
      hint: { key: "esc", label: "cancel turn", icon: "✖", iconSvg: faXmark },
    },
    {
      keys: ["d", "D"],
      down: onPress("disarm"),
      hint: {
        key: "d",
        label: "disarm (abandon all)",
        icon: "💤",
        iconSvg: faMoon,
        tone: "danger",
      },
    },
    {
      // The keymap as a table, under the caps (the overlay's ? — same rows).
      keys: ["?"],
      down: onPress("help"),
      hint: { key: "?", label: "help", icon: "❓", iconSvg: faQuestion },
    },
  ],
  fallback: "swallow",
};

const STACK: readonly KeyLayer<LeaderState, LeaderAction>[] = [turnLayer];

/**
 * Map one key event to a {@link LeaderEvent}. Pure — the panel's document
 * listener and the content script's forwarded keys both funnel through this.
 */
export function leaderKeyEvent(
  state: LeaderState,
  key: string,
  phase: "down" | "up",
  repeat: boolean,
): LeaderEvent {
  if (state.phase !== "turn") {
    return { kind: "pass" };
  }
  // Keyups are swallowed wholesale while composing — except Space's, which
  // ENDS a push-to-talk hold (C5). The keydowns they pair with were ours, and
  // none of them may leak to the page.
  if (phase === "up") {
    return key === " " ? { kind: "action", action: "talkRelease" } : { kind: "stay" };
  }
  const claim = resolveKey(STACK, state, key, phase, repeat);
  if (claim === "pass") {
    // Unreachable while composing (fallback swallows) — kept for shape-safety.
    return { kind: "stay" };
  }
  if (claim === "swallow") {
    if (MODIFIER_KEYS.has(key) || repeat) {
      return { kind: "stay" };
    }
    return { kind: "ignored", key }; // a typo: blip it, keep composing
  }
  return { kind: "action", action: claim.command };
}

/** The hint rows for a state — drives the PANEL strip (page shows nothing). */
export function leaderHints(state: LeaderState): KeyHint[] {
  return keyHints(STACK, state);
}

/** The strip as one line of text for the panel header. */
export function leaderHintText(state: LeaderState): string {
  return leaderHints(state)
    .map((h) => `${h.key} ${h.label}`)
    .join(" · ");
}

/**
 * The whole extension keymap as help-table data (the overlay's `KeymapHelp`
 * renders it), generated by running the REAL layer stack against one
 * representative state per phase — the table cannot drift from the bindings.
 * The ⌘B row is authored, not resolved: the leader is a browser-global
 * `chrome.commands` shortcut, not a row in this stack (§13.6).
 */
export function leaderHelp(): KeymapHelpSection[] {
  const at = (over: Partial<LeaderState> = {}): LeaderState => ({
    phase: "turn",
    inkOn: false,
    selectionPresent: false,
    talking: false,
    holdTalk: false,
    micMuted: false,
    videoOn: false,
    fpsSmart: true,
    ...over,
  });
  const base = leaderHints(at());
  const inking = leaderHints(at({ inkOn: true }));
  const fresh = inking.filter((h) => !base.some((b) => b.key === h.key));
  const leaderRow: KeyHint = {
    key: "⌘B",
    label: "open a turn · grant this tab",
    icon: "✳",
    iconSvg: faAsterisk,
  };
  return [
    {
      title: "in a turn",
      note: "the keyboard is aiui's — an unknown key is swallowed with a flash",
      hints: [leaderRow, ...base],
    },
    {
      title: "while inking",
      note: "i — the pointer draws; strokes are page-anchored and survive the turn",
      hints: fresh,
    },
    {
      title: "armed, no turn",
      note: "presence only: the border shows, every key goes to the page",
      hints: [leaderRow],
    },
    {
      title: "tweak",
      note: "t — the page has keyboard and pointer; the turn stays open",
      hints: [{ key: "⌘B", label: "resume the turn", icon: "🔧", iconSvg: faWrench }],
    },
  ];
}

/** How long the `× key` feedback blip stays up in the panel strip. */
export const LEADER_BLIP_MS = 500;

/** How stale a pending leader may be and still act at panel boot. */
export const LEADER_PENDING_TTL_MS = 5000;

/** A pending leader press the SW parked for a panel that wasn't open yet. */
export interface PendingLeader {
  tabId?: number;
  at: number;
}

/** Whether a parked leader press should still act. Pure. */
export function leaderPendingFresh(
  pending: PendingLeader | null | undefined,
  now: number,
): boolean {
  return pending != null && now - pending.at <= LEADER_PENDING_TTL_MS;
}
