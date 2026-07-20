/**
 * spec.ts — the intent client's machine, as data.
 *
 * This file IS the conductor: the ~1,500 lines of hand-rolled orchestration
 * the retired extension panel grew (its `main.tsx` §13.6 machine — git
 * history) reduce to this spec plus
 * the claims (./claims.ts) and the verb effects (./client.ts). Every row
 * traces to docs/proposals/intent-client/04-parity-inventory.md; every
 * decided semantic from the salvage list is a reduction or an exclude here,
 * and a test in spec.test.ts.
 *
 * Decided semantics carried (each was paid for live — README "salvage"):
 *  - the invocation gesture is GRANT-ONLY (owner, 2026-07-20): arming belongs
 *    to the connection (client.ts arms on the connected edge), turns to the
 *    turn cap — no gesture escalates, and nothing ever auto-cancels
 *  - Esc steps out one level (help before turn-cancel), never destructive
 *    beyond scope, and never disarms (the ladder's escFloor)
 *  - send keeps you armed; disarm is its own deliberate command
 *  - pencil · area · jump are the three PAGE-POINTER TOOLS, mutually
 *    exclusive — one owns the page pointer at a time (turning any on turns the
 *    others off). pencil is durable (survives turns; disarm clears it);
 *    area/jump are transient (need an open turn — tools-need-turn clears them off
 *    it) and AUTO-EXIT after their one act (regionDone/jumpDone). Esc unwinds the
 *    active tool before the phase ladder (escOrder) — one Escape source, no
 *    page-side split-brain. (owner, 2026-07-16)
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
import type { CdpAlignment } from "./cdp-align";

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
  /** Connected remote pencil (iPad) clients (0 = none), fed live from the
   * pencil relay's HostSession status. */
  pencilClients: number;
  /** The active tab is aiui-INSTRUMENTED (window.__AIUI__): it can host
   * jump-to-editor. */
  aiuiPage: boolean;
  /** CDP alignment: does the browser this client runs in match the browser
   * the bound channel drives (src/cdp-align.ts)? Undefined until the
   * supervisor's first verdict. Drives the `cdp` pill, rides the hello meta
   * into the prompt prelude, and gates browser-tooling features. */
  cdpAlignment: CdpAlignment | undefined;
}

export const initialContext: IntentContext = {
  activeTab: undefined,
  grantedTab: undefined,
  selectionPresent: false,
  connected: false,
  micGranted: undefined,
  pencilClients: 0,
  aiuiPage: false,
  cdpAlignment: undefined,
};

/**
 * The spec. Region lifecycles, in the inventory's vocabulary: `phase` is the
 * machine; pencil/video/videoMode are standing (durable) settings; talk/micMuted
 * are per-turn; help is transient.
 */
export const intentSpec: ModeEngineSpec<IntentContext> = {
  regions: {
    /** THE machine: disarmed ⊂ armed ⊂ turn, tweak a submode of turn. Esc
     * unwinds the WHOLE ladder one level per press (owner, 2026-07-13):
     * tweak → turn → armed → disarmed — stepping out of armed IS disarming,
     * and there is only one disarmed (the hard one; see the exclude). */
    phase: ladder(["disarmed", "armed", "turn", "tweak"]),
    /** Pencil markup mode (owner, 2026-07-16): standing (survives turns),
     * durable, disarm clears it. On ⇒ the pencilSurface claim engages the page
     * surface (mouse + pen + iPad); strokes survive turns until cleared. Vanish
     * on/off + fade live in config (pencilVanish/pencilFade). */
    pencil: toggle({ durable: true }),
    /** Area drag — the rubber-band region shot (`a`), now a TOGGLE, not a
     * one-shot verb (owner, 2026-07-16). On ⇒ the regionSurface claim raises the
     * crosshair overlay on the granted tab; a completed drag fires the shot AND
     * flips this off (auto-exit). TRANSIENT: it needs an open turn and pixels, so
     * leaving the turn clears it (tools-need-turn). One of the four page-pointer
     * tools — turning it on turns pencil/jump off (the command clears them). */
    region: toggle(),
    /** Jump-to-editor pick (`j`), a TOGGLE like area (owner, 2026-07-16). On ⇒
     * the jumpSurface claim raises the picker on the instrumented tab in view; a
     * commit or cancel flips this off (auto-exit, via the page's jumpDone). Also
     * a page-pointer tool: mutually exclusive with pencil/area. Transient. */
    jump: toggle(),
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
    /** The keymap table popup. Esc dismisses it BEFORE the cancel rung.
     * Deliberately NOT blurExits (owner, 2026-07-15): help is a reference
     * card you read while your hands are on the TARGET page — dying the
     * moment the panel loses focus defeated it. */
    help: toggle(),
  },

  commands: {
    // NOTE deliberately absent: an "activate" command. The extension's
    // invocation gesture (toolbar click, context-menu grant) is NOT a key in
    // this modal system — it is an imperative event from outside, handled by
    // activationGesture(), and it only records the capture grant (a context
    // fact, not a region). Arming rides the channel-connected edge instead
    // (client.ts). See ./activation.ts.
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
    // The three page-pointer tools are MUTUALLY EXCLUSIVE (owner, 2026-07-16):
    // pencil, area, and jump each own the page pointer with a full-viewport
    // overlay, so at most one is on. Turning any ON clears the other two; the
    // reducer expresses the exclusion directly (an exclude can't — it can't say
    // "the last one pressed wins"). Turning OFF just clears itself.
    /** k — toggle pencil markup mode (standing; the claim gates on turn). */
    pencil: (s): StatePatch =>
      s.pencil ? { pencil: false } : { pencil: true, region: false, jump: false },
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

    /** a — toggle the area drag (rubber band → cropped shot); on ⇒ pencil/jump
     * off. The regionSurface claim raises/lowers the crosshair; a completed drag
     * auto-exits via `regionDone`. */
    region: (s): StatePatch =>
      s.region ? { region: false } : { region: true, pencil: false, jump: false },
    /** j — toggle the jump-to-editor pick (aiui pages only); on ⇒ pencil/area
     * off. The jumpSurface claim raises/lowers the picker; a commit/cancel
     * auto-exits via `jumpDone`. */
    jump: (s): StatePatch =>
      s.jump ? { jump: false } : { jump: true, pencil: false, region: false },
    /** The page reported a completed area drag — auto-exit the mode (idempotent
     * force-off, so it never toggles back ON if already cleared). */
    regionDone: () => ({ region: false }),
    /** The page reported a committed/cancelled jump pick — auto-exit (force-off). */
    jumpDone: () => ({ jump: false }),

    // Pure verbs — no state to move; the client's effect layer acts on the
    // dispatch event (shot flash, selection pull, stroke clear). Declared so
    // caps/keys/tests share one command vocabulary.
    shot: () => null,
    /** Clear the pencil surface. */
    pencilClear: () => null,
    selection: () => null,
  },

  /** Esc's one-level ladder (owner, 2026-07-16): help first, then the active
   * page-pointer TOOL (area/jump — one press cancels the pick and stays in the
   * turn), then the phase rung (tweak → turn → armed, never past the floor).
   * This is what dissolves the old region/jump Escape split-brain: the tool is
   * mode-engine state now, so ONE Escape source unwinds it — the page overlay no
   * longer runs its own private Escape listener. (area and jump are mutually
   * exclusive, so at most one of these two ever steps.) */
  escOrder: ["help", "region", "jump", "phase"],

  excludes: [
    // ONE disarmed, and it is HARD (owner, 2026-07-13): however you get
    // there — the d key, the arm toggle, Esc unwinding the last rung — pencil
    // markup mode clears. Declared once as an invariant, not remembered per
    // route. (Standing video/videoMode survive disarm, as in the retired client.)
    {
      name: "disarmed-is-hard",
      when: (s) => s.phase === "disarmed",
      set: { pencil: false },
    },
    // The page-pointer TOOLS that need pixels/a live pick — area and jump — are
    // transient (owner, 2026-07-16): they only make sense inside an open turn
    // (area needs the grant, jump needs the picker on the tab in view), and in
    // tweak the page owns the pointer. So leaving the turn SCOPE — into tweak,
    // armed, or disarmed — clears them. (pencil is durable and survives into
    // tweak; only disarm clears it, above.)
    {
      name: "tools-need-turn",
      when: (s) => s.phase !== "turn" && (s.region === true || s.jump === true),
      set: { region: false, jump: false },
    },
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
   * the channel gate on arming. Everything else — pencil/tweak/send/mute/turn
   * disabled while disarmed, escape at the floor — derives from the dry-run.
   */
  available: {
    // Arming needs a channel. Note the shape: you can always arm DOWN
    // (disarm), whatever the world says.
    arm: (s, ctx) => s.phase !== "disarmed" || ctx.connected,
    // NOTE deliberately NO `turn` gate: a turn is a WIRE concept — talk and
    // text work grantless — so armed → turn derives from the reducer. The
    // capture GRANT gates the capture-dependent acts individually (below);
    // the invocation gesture mints it (found live: gating the turn cap on
    // the grant dead-ended the bar for anyone who armed via the cap).
    // …and only while the tab in view IS the granted tab: after a tab switch
    // the grant persists on the old tab, and shooting a tab you are not
    // looking at would contradict the hollow ring saying "no pixels here".
    // (Grantless hosts keep the two in lockstep, so this never bites there.)
    shot: (s, ctx) =>
      s.phase === "turn" && ctx.grantedTab !== undefined && ctx.grantedTab === ctx.activeTab,
    // The area drag is pixels too — turning it ON wants the same grant as a shot;
    // turning it OFF is always allowed (so a lost grant can't strand you in area
    // mode — you can always toggle back out, and Esc bypasses `available`).
    region: (s, ctx) =>
      s.region === true ||
      (s.phase === "turn" && ctx.grantedTab !== undefined && ctx.grantedTab === ctx.activeTab),
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
    jump: (s, ctx) =>
      s.jump === true || (s.phase === "turn" && ctx.activeTab !== undefined && ctx.aiuiPage),
    // Pencil markup is a PAGE act (the surface follows the tab in view, no grant
    // — a mouse, a stylus, and the iPad's strokes all land in-page). Its clear is
    // enabled only while pencil mode is on in an open turn (owner, 2026-07-16).
    // Vanish/fade are config controls, not commands.
    pencilClear: (s, ctx) => s.phase === "turn" && s.pencil === true && ctx.activeTab !== undefined,
  },
};
