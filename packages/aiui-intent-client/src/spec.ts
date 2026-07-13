/**
 * spec.ts — the intent client's machine, as data.
 *
 * This file IS the conductor: the ~1,500 lines of hand-rolled orchestration
 * the old panel grew (`main.tsx`'s §13.6 machine) reduce to this spec plus
 * the claims (./claims.ts) and the verb effects (./client.ts). Every row
 * traces to docs/proposals/intent-client/04-parity-inventory.md; every
 * decided semantic from the salvage list is a reduction or an exclude here,
 * and a test in spec.test.ts.
 *
 * Decided semantics carried (each was paid for live — README "salvage"):
 *  - ⌘B is idempotent grant-and-open, never cancels
 *  - Esc steps out one level (help before turn-cancel), never destructive
 *    beyond scope, and never disarms (the ladder's escFloor)
 *  - send keeps you armed; disarm is its own deliberate command
 *  - disarm turns ink mode off; nothing else does (parity 1C, divergence 5)
 *  - standing video/videoMode survive turns and disarm (standing settings)
 *  - talk is per-turn: leaving the turn ends it (an exclude, not a memory)
 *  - mute exists only while talking; starting talk starts unmuted
 */

import { choice, ladder, type ModeEngineSpec, toggle } from "@habemus-papadum/aiui-viz/modal";

/** The world's facts (inputs, not choices — no command sets these). */
export interface IntentContext {
  /** The tab the user is looking at (targeting; ring/keys follow it). */
  activeTab: number | undefined;
  /** The tab whose capture the user granted (⌘B's invocation gate). */
  grantedTab: number | undefined;
  /** The page reported a live selection (affordance only — pull model). */
  selectionPresent: boolean;
  /** The channel session is connected (arming requires it). */
  connected: boolean;
}

export const initialContext: IntentContext = {
  activeTab: undefined,
  grantedTab: undefined,
  selectionPresent: false,
  connected: false,
};

/**
 * The spec. Region lifecycles, in the inventory's vocabulary: `phase` is the
 * machine; ink/video/videoMode are standing (durable) settings; talk/micMuted
 * are per-turn; help is transient.
 */
export const intentSpec: ModeEngineSpec<IntentContext> = {
  regions: {
    /** THE machine: disarmed ⊂ armed ⊂ turn, tweak a submode of turn. */
    phase: ladder(["disarmed", "armed", "turn", "tweak"], { escFloor: "armed" }),
    /** Ink mode — standing (survives turns), durable; disarm clears it. */
    ink: toggle({ durable: true }),
    /** Video sampling — standing, durable, agent-visible. */
    video: toggle({
      durable: true,
      agent: "videoOn",
      description: "sample tab frames into the turn",
    }),
    /** Cadence: smart (interaction-gated) or constant (the period slider). */
    videoMode: choice(["smart", "constant"], {
      durable: true,
      agent: "videoMode",
      description: "video cadence: smart (interaction-gated) or constant",
    }),
    /** One talk window at a time: hold (Space) or hands-free (h). Per-turn. */
    talk: choice(["off", "hold", "handsFree"]),
    /** Mic muted — only meaningful while talking (an exclude clears it). */
    micMuted: toggle(),
    /** The keymap table popup. Esc dismisses it BEFORE the cancel rung. */
    help: toggle({ blurExits: true }),
  },

  commands: {
    /**
     * ⌘B — the browser-global whose meaning is state-dependent, but never
     * destructive: grant-and-open from anywhere, resume from tweak, no-op in
     * an open turn (idempotent — a second press must never cancel).
     */
    cmdB: (s) => (s.phase === "turn" ? null : { phase: "turn" }),
    /** Enter — send the turn; the seat stays armed (divergence 2, decided). */
    send: (s) => (s.phase === "turn" || s.phase === "tweak" ? { phase: "armed" } : null),
    /** d — deliberate full abandonment: everything off, ink mode included. */
    disarm: () => ({ phase: "disarmed", ink: false }),
    /** t — hand keyboard and pointer back to the page; the turn stays open. */
    tweak: (s) => (s.phase === "turn" ? { phase: "tweak" } : null),
    /** i — toggle ink mode (standing). */
    ink: (s) => ({ ink: !(s.ink as boolean) }),
    /** v — toggle video sampling (standing; the claim gates on turn). */
    video: (s) => ({ video: !(s.video as boolean) }),
    /** f — flip the cadence. */
    fpsMode: (s) => ({ videoMode: s.videoMode === "smart" ? "constant" : "smart" }),
    /** Space down — open a hold-to-talk window (starts unmuted). */
    talkPress: (s) =>
      s.phase === "turn" && s.talk === "off" ? { talk: "hold", micMuted: false } : null,
    /** Space up — ends only a HOLD window (hands-free ignores it). */
    talkRelease: (s) => (s.talk === "hold" ? { talk: "off" } : null),
    /** h — toggle hands-free talk (starts unmuted). */
    handsFree: (s) =>
      s.phase !== "turn"
        ? null
        : s.talk === "handsFree"
          ? { talk: "off", micMuted: false }
          : { talk: "handsFree", micMuted: false },
    /** m — mute/unmute, only while a talk window is open. */
    mute: (s) => (s.talk !== "off" ? { micMuted: !(s.micMuted as boolean) } : null),
    /** ? — the keymap table. */
    help: (s) => ({ help: !(s.help as boolean) }),

    /** The wire closed the thread under us (idle timeout, server end). */
    turnEnded: (s) => (s.phase === "turn" || s.phase === "tweak" ? { phase: "armed" } : null),

    // Pure verbs — no state to move; the client's effect layer acts on the
    // dispatch event (shot flash, selection pull, stroke clear). Declared so
    // caps/keys/tests share one command vocabulary.
    shot: () => null,
    selection: () => null,
    clear: () => null,
  },

  /** Esc's one-level ladder: help first, then the phase rung (tweak → turn
   * → armed — never past the floor to disarmed). */
  escOrder: ["help", "phase"],

  excludes: [
    // Talk is per-turn: whoever moved the phase, leaving "turn" ends it
    // (send, cancel, disarm, tweak, idle-timeout binding — no site can forget).
    { name: "talk-is-per-turn", when: (s) => s.phase !== "turn", set: { talk: "off" } },
    // Mute exists only while talking.
    { name: "mute-needs-talk", when: (s) => s.talk === "off", set: { micMuted: false } },
    // The help popup belongs to the open turn.
    { name: "help-is-in-turn", when: (s) => s.phase !== "turn", set: { help: false } },
  ],

  on: {
    /** The wire closed the thread (idle timeout, server end): back to armed. */
    turnClosed: "turnEnded",
    /** Window blur — the built-in blur resolution (transients die). */
    windowBlur: "blur",
  },
};
