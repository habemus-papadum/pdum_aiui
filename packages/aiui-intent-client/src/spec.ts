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
 *  - talk is per-turn: leaving the turn SCOPE (armed/disarmed) ends it — but
 *    tweak PAUSES hands-free talk (mic quiet, resumes on return); hold always
 *    ends (its physical key leaves with tweak). Excludes, not a memory.
 *  - mute exists only while talking; starting talk starts unmuted
 */

import {
  choice,
  ladder,
  type ModeEngineSpec,
  type StatePatch,
  toggle,
} from "@habemus-papadum/aiui-viz/modal";

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
  /** Mic permission: undefined = never asked, then granted or denied.
   * A status-pill fact today; the talk lane supplies it in Phase 2. */
  micGranted: boolean | undefined;
  /** Connected iPad paint clients (0 = none). Phase 2 wires the real count. */
  paintClients: number;
  /** The active tab is aiui-INSTRUMENTED (window.__AIUI__): it answers the
   * `locate` capability and can host jump-to-editor (the overlay's vscode
   * mode — anticipated here, built post-parity). */
  aiuiPage: boolean;
  /** The FROZEN client has this tab armed. Two clients inking one page is
   * nonsense and they cannot negotiate (no messaging across extension ids), so
   * the new one refuses to arm and says why — the coexistence policy. */
  foreignArmed: boolean;
}

export const initialContext: IntentContext = {
  activeTab: undefined,
  grantedTab: undefined,
  selectionPresent: false,
  connected: false,
  micGranted: undefined,
  paintClients: 0,
  aiuiPage: false,
  foreignArmed: false,
};

/**
 * The spec. Region lifecycles, in the inventory's vocabulary: `phase` is the
 * machine; ink/video/videoMode are standing (durable) settings; talk/micMuted
 * are per-turn; help is transient.
 */
export const intentSpec: ModeEngineSpec<IntentContext> = {
  regions: {
    /** THE machine: disarmed ⊂ armed ⊂ turn, tweak a submode of turn. Esc
     * unwinds the WHOLE ladder one level per press (owner, 2026-07-13):
     * tweak → turn → armed → disarmed — stepping out of armed IS disarming,
     * and there is only one disarmed (the hard one; see the exclude). */
    phase: ladder(["disarmed", "armed", "turn", "tweak"]),
    /** Ink mode — standing (survives turns), durable; disarm clears it. */
    ink: toggle({ durable: true }),
    /** Video sampling — standing, durable, agent-visible. */
    video: toggle({
      durable: true,
      agent: "videoOn",
      description: "sample tab frames into the turn",
    }),
    /** Pencil vanishing mode — standing, durable, agent-visible. Off = strokes
     * persist on the page; on = they fade over the pencilFade lifetime. The
     * pencil surface itself engages with the turn (page/pencil-mount.ts). */
    pencilVanish: toggle({
      durable: true,
      agent: "pencilVanish",
      description: "pencil strokes fade out instead of persisting",
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
    /** The keymap table popup. Esc dismisses it BEFORE the cancel rung.
     * Deliberately NOT blurExits (owner, 2026-07-15): help is a reference
     * card you read while your hands are on the TARGET page — dying the
     * moment the panel loses focus defeated it. */
    help: toggle(),
  },

  commands: {
    // NOTE deliberately absent: a "cmdB" command. The browser-global
    // activation shortcut is NOT a key in this modal system — it is an
    // imperative event from outside (chrome.commands in the extension, a
    // window listener in the plain page) handled by activationGesture(),
    // which crosses the boundary as sequential idempotent dispatches of the
    // commands below. See ./activation.ts.
    /**
     * The bar's arm cap — a status indicator you can press: arms from
     * disarmed, disarms from anywhere else (the disarmed-is-hard exclude
     * does the clearing). Gated on the channel via `available` below.
     */
    arm: (s): StatePatch => {
      if (s.phase === "disarmed") {
        return { phase: "armed" };
      }
      return { phase: "disarmed" };
    },
    /** The bar's turn cap — a TOGGLE (owner, 2026-07-14): opens a turn from
     * armed; pressed again mid-turn it ABANDONS the turn back to armed (the
     * escape-from-turn rung, one click). The verb effects treat it like
     * escape: leaving the turn via `turn` cancels the thread. */
    turn: (s) =>
      s.phase === "armed"
        ? { phase: "turn" }
        : s.phase === "turn" || s.phase === "tweak"
          ? { phase: "armed" }
          : null,
    /** Enter — send the turn; the seat stays armed (divergence 2, decided). */
    send: (s) => (s.phase === "turn" || s.phase === "tweak" ? { phase: "armed" } : null),
    /** d — disarm from anywhere in-turn (same hard disarmed as everything). */
    disarm: () => ({ phase: "disarmed" }),
    /**
     * t — hand keyboard and pointer back to the page; the turn stays open.
     * A TOGGLE: the panel's tweak cap also releases it (in tweak the page
     * owns every ordinary key, so the cap and ⌘B are the only ways back —
     * pressing T on the page must pass through to the page).
     */
    tweak: (s) =>
      s.phase === "turn" ? { phase: "tweak" } : s.phase === "tweak" ? { phase: "turn" } : null,
    /** i — toggle ink mode (standing). */
    ink: (s) => ({ ink: !(s.ink as boolean) }),
    /** v — toggle video sampling (standing; the claim gates on turn). */
    video: (s) => ({ video: !(s.video as boolean) }),
    /** Toggle pencil vanishing mode (standing; the live effect re-relays fade). */
    pencilVanish: (s) => ({ pencilVanish: !(s.pencilVanish as boolean) }),
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
    /** a — arm a one-shot region drag on the page (rubber band → cropped shot). */
    region: () => null,
    /** j — arm the one-shot jump-to-editor pick (aiui pages only). */
    jump: () => null,
    /** Clear the pencil surface (the pencil's own clear, distinct from ink's). */
    pencilClear: () => null,
    selection: () => null,
    clear: () => null,
  },

  /** Esc's one-level ladder: help first, then the phase rung (tweak → turn
   * → armed — never past the floor to disarmed). */
  escOrder: ["help", "phase"],

  excludes: [
    // ONE disarmed, and it is HARD (owner, 2026-07-13): however you get
    // there — the d key, the arm toggle, Esc unwinding the last rung — ink
    // mode clears. Declared once as an invariant, not remembered per route.
    // (Standing video/videoMode survive disarm, as in the old client.)
    { name: "disarmed-is-hard", when: (s) => s.phase === "disarmed", set: { ink: false } },
    // Talk and tweak (owner, 2026-07-16): tweak PAUSES hands-free talk rather
    // than ending it — the mic goes quiet (client.ts drives the mute off the
    // phase) and RESUMES when you step back to the turn, so the talk window
    // and its linter window survive the detour. Two rules encode that:
    //  · a HOLD window is bound to a physical key, and tweak hands keys to the
    //    page — you can no longer be "holding" — so hold ends whenever you
    //    leave the turn, tweak included.
    {
      name: "hold-needs-turn",
      when: (s) => s.phase !== "turn" && s.talk === "hold",
      set: { talk: "off" },
    },
    //  · hands-free talk ends only when you leave the turn SCOPE entirely
    //    (armed/disarmed) — not into tweak, where it is merely paused.
    {
      name: "handsfree-off-turn",
      when: (s) => s.phase !== "turn" && s.phase !== "tweak" && s.talk === "handsFree",
      set: { talk: "off" },
    },
    // Mute exists only while talking.
    { name: "mute-needs-talk", when: (s) => s.talk === "off", set: { micMuted: false } },
    // (help is a root-level standing toggle — owner review 2026-07-13: the
    // blank system shows arm · step out · help. It survives blur — a
    // reference card must be readable while the page has focus.)
  ],

  on: {
    /** The wire closed the thread (idle timeout, server end): back to armed. */
    turnClosed: "turnEnded",
    /** Window blur — the built-in blur resolution (transients die). */
    windowBlur: "blur",
  },

  /**
   * Availability the reducer can't derive: verbs (they move no region) and
   * the channel gate on arming. Everything else — ink/tweak/send/mute/turn
   * disabled while disarmed, escape at the floor — derives from the dry-run.
   */
  available: {
    // Arming needs a channel — and a tab the frozen client is not already
    // holding (the coexistence policy: never both armed on one page). Note the
    // shape: you can always arm DOWN (disarm), whatever the world says.
    arm: (s, ctx) => s.phase !== "disarmed" || (ctx.connected && !ctx.foreignArmed),
    // NOTE deliberately NO `turn` gate: a turn is a WIRE concept — talk and
    // text work grantless — so armed → turn derives from the reducer. The
    // capture GRANT gates the capture-dependent acts individually (below);
    // the activation shortcut mints it (found live: gating the turn cap on
    // the grant dead-ended the bar for anyone who armed via the cap).
    // …and only while the tab in view IS the granted tab: after a tab switch
    // the grant persists on the old tab, and shooting a tab you are not
    // looking at would contradict the hollow ring saying "no pixels here".
    // (Grantless hosts keep the two in lockstep, so this never bites there.)
    shot: (s, ctx) =>
      s.phase === "turn" && ctx.grantedTab !== undefined && ctx.grantedTab === ctx.activeTab,
    // The region drag is pixels too — same gate as shot.
    region: (s, ctx) =>
      s.phase === "turn" && ctx.grantedTab !== undefined && ctx.grantedTab === ctx.activeTab,
    // Selection and clear are PAGE acts, not pixel acts (owner, 2026-07-14):
    // they ride the content script / bootstrap, which follows the tab in
    // view — no grant involved. Only pixels (shot, the stream, sampling) need
    // the invocation-gated grant. This is the tab-switch friction fix: under
    // MV3, switching tabs darkens CAPTURE only, and the hollow ring says how
    // to re-grant. The doctrine: the page transport follows the tab in view;
    // pixels follow the grant.
    // …and only when the page actually HAS one (owner, 2026-07-14): a
    // selection pull with nothing selected is a guaranteed miss — the cap
    // grays and its tooltip points at tweak mode instead.
    selection: (s, ctx) =>
      s.phase === "turn" && ctx.activeTab !== undefined && ctx.selectionPresent,
    // Jump-to-editor is a PAGE act on instrumented pages only: the picker
    // reads the aiui stamps and source root, so a page without `__AIUI__`
    // grays the cap — the gate IS the feature detection (owner, 2026-07-15).
    jump: (s, ctx) => s.phase === "turn" && ctx.activeTab !== undefined && ctx.aiuiPage,
    clear: (s, ctx) => s.phase === "turn" && s.ink === true && ctx.activeTab !== undefined,
    // Pencil markup is a PAGE act (the surface follows the tab in view, no grant
    // — a stylus and the iPad's strokes both land in-page). The vanish MODE is a
    // standing setting but only meaningful with a live surface, so both gate on
    // an open turn with a tab (owner, 2026-07-15).
    pencilVanish: (s, ctx) => s.phase === "turn" && ctx.activeTab !== undefined,
    pencilClear: (s, ctx) => s.phase === "turn" && ctx.activeTab !== undefined,
  },
};
