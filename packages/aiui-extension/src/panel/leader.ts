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
 * state-dependent meaning (arm+turn / turn / ladder / resume) the panel
 * resolves — it must stay global because in tweak the page owns every
 * ordinary key and only the leader can reach us.
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
  | "cancel";

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
        active: state.inkOn,
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
      hint: (state) => ({
        key: "a",
        label: "add selection",
        icon: "📋",
        active: state.selectionPresent,
      }),
    },
    {
      // Clear the sketch (the overlay's C). Gated on ink mode for now — see
      // PHASE-A.md gap 2 (should offer whenever strokes exist).
      keys: ["c", "C"],
      down: (state, _key, repeat) => (!repeat && state.inkOn ? command("clear") : "swallow"),
      hint: (state) => (state.inkOn ? { key: "c", label: "clear ink", icon: "🧹" } : undefined),
    },
    {
      // Tweak: hand keyboard AND pointer back to the page, turn stays open.
      // Only ⌘B can resume (the page owns every ordinary key in tweak).
      keys: ["t", "T"],
      down: onPress("tweak"),
      hint: { key: "t", label: "tweak the page", icon: "🔧" },
    },
    {
      keys: ["d", "D"],
      down: onPress("disarm"),
      hint: { key: "d", label: "disarm (abandon all)", icon: "💤" },
    },
    {
      keys: ["Enter"],
      down: onPress("send"),
      hint: { key: "⏎", label: "send", icon: "📤" },
    },
    {
      // The ladder's in-turn rung: cancel the turn, stay armed. (Sub-layers —
      // strip, picker — slot above this when they arrive in Phase C.)
      keys: ["Escape"],
      down: onPress("cancel"),
      hint: { key: "esc", label: "cancel turn" },
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
  // Keyups are swallowed wholesale while composing: the keydowns they pair
  // with were ours, and none of them may leak to the page.
  if (phase === "up") {
    return { kind: "stay" };
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
