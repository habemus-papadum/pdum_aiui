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
 *    beyond scope — and the ladder has NO floor: the last step IS disarm
 *    (BEHAVIOR.md "step out"; pinned in spec.test.ts)
 *  - send keeps you armed; disarm is its own deliberate command
 *  - pencil · area · jump are the three PAGE-POINTER TOOLS, mutually
 *    exclusive — one owns the page pointer at a time (turning any on turns the
 *    others off). pencil and jump are durable, ARMED-scope (survive turns;
 *    disarm clears them — C3'); area is transient (needs an open turn —
 *    area-needs-turn clears it). area/jump AUTO-EXIT after their one act
 *    (regionDone/jumpDone). Esc unwinds the active tool before the phase
 *    ladder (escOrder) — one Escape source, no page-side split-brain.
 *  - standing video/videoMode survive turns and disarm (standing settings)
 *  - talk is per-turn: leaving the turn SCOPE (armed/disarmed) ends it — but
 *    hands-free is a STANDING mode (C3'): survives turns, disarm clears;
 *    hold always ends with the turn (its physical key lives in the turn
 *    grammar). Excludes, not a memory.
 *  - mute exists only while talking; starting talk starts unmuted
 */

import {
  choice,
  type EngineState,
  ladder,
  type ModeEngineSpec,
  type StatePatch,
  toggle,
} from "@habemus-papadum/aiui-viz/modal";
import type { CdpAlignment } from "./cdp-align";

/**
 * The SINK — where contributions route (owner, 2026-07-30; BEHAVIOR.md "The
 * sink"). Everything that ADDS to a turn — transcribed audio, shots, the area
 * drag, selection pulls, sampled frames, a hold-to-talk press — gates on this,
 * not on the phase. `undefined` = nothing is collecting.
 *
 * The ORACLE WINS when it is on (O3a, docs/proposals/intent-oracle.md): an
 * open turn is therefore paused *by construction* — the sink is simply
 * elsewhere — and leaving the oracle restores whatever that turn's own state
 * was, because the oracle never writes the manual `paused` region. No memory,
 * no restore logic, anywhere.
 */
export type Sink = "turn" | "oracle";

export function sink(s: EngineState): Sink | undefined {
  if (s.oracle === true) {
    return "oracle";
  }
  return s.phase === "turn" && s.paused !== true ? "turn" : undefined;
}

/**
 * The turn EXISTS but is not collecting — the lanes' pause condition, and
 * deliberately broader than the `paused` region: the oracle taking the sink
 * suspends the turn exactly as the ⏸ cap does, so both causes produce the same
 * stream bracket, the same boundary suppression, and the same resume compare
 * (lanes/capture-lanes.ts). A turn that has CLOSED is not suspended — the
 * close is its own outer bracket.
 */
export function turnSuspended(s: EngineState): boolean {
  return s.phase === "turn" && sink(s) !== "turn";
}

/**
 * Where a PIXEL/SELECTION contribution may go today — the turn only.
 *
 * The audio routing to the oracle is wired (O3a: the mic gate follows the talk
 * grip into either sink), but shots, area drags, and selection pulls still know
 * one destination, so they must refuse while the oracle holds the sink rather
 * than land in the suspended turn behind it. O3d — which teaches the lane verbs
 * to fork on the sink — is the one place this narrowing is lifted, and then
 * these gates go back to reading `sink(s) !== undefined`.
 */
function contributesToTurn(s: EngineState): boolean {
  return sink(s) === "turn";
}

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
    /** THE machine: disarmed ⊂ armed ⊂ turn. (Tweak DIED in C3′, owner
     * 2026-07-25: armed means the grammar is live — a few claimed keys — and
     * a turn claims the whole keyboard; DISARM is the escape hatch, and the
     * page keeps its pointer unless an explicit mode owns it.) Esc unwinds
     * the ladder one level per press: turn → armed → disarmed — stepping out
     * of armed IS disarming, and there is only one disarmed (the hard one;
     * see the exclude). */
    phase: ladder(["disarmed", "armed", "turn"]),
    /** Collection paused (⏸ / `b` — owner, 2026-07-30): the turn stays open
     * and keeps everything in it, but the SINK goes away — no new audio,
     * shots, or selections enter it (BEHAVIOR.md "The sink, and pausing a
     * turn"). Orthogonal to the phase ladder on purpose (not a rung — Esc is
     * untouched); meaningful only in a turn (`pause-needs-turn`); deliberately
     * NOT durable — a recovered turn resumes collecting. */
    paused: toggle(),
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
     * a page-pointer tool: mutually exclusive with pencil/area. ARMED-scope
     * since C3′ (owner: an editor act, not a prompt act) — durable like pencil;
     * disarm clears it. */
    jump: toggle({ durable: true }),
    /** The ORACLE — a live realtime voice session (O3a, owner 2026-07-30):
     * armed-scope and standing like pencil/jump, durable, cleared by
     * `disarmed-is-hard` (a WebRTC session must never outlive disarm). The
     * region is the DESIRE; the `oracleSession` claim is the reconciled
     * reality (connecting / live / failed), so a mint 503 or a refused mic
     * surfaces through the claim status, never through a flag out of step
     * with a connection. Deliberately NOT in `escOrder`, like the other
     * standing modes — `d` / the arm cap is the hard exit. */
    oracle: toggle({
      durable: true,
      agent: "oracleOn",
      description: "hold a live oracle voice session (pauses the turn while on)",
    }),
    /** Park — the oracle's own "hold my place" (mic gated, connection open,
     * $0). Its own region rather than a re-labelled mute (owner, 2026-07-30):
     * independent of the talk GRIP, so parking never destroys hands-free and
     * un-parking restores it. Meaningless without a session (`park-needs-oracle`). */
    oracleParked: toggle(),
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
    /** One talk grip at a time: hold (Space, turn-only — a gesture) or
     * hands-free (h — a STANDING mode since C3′: survives turns; the capture
     * WINDOW opens only while a consumer exists, i.e. a turn; disarm clears).
     * Durable so window blur never kills the standing mode (the panel blurs
     * every time you touch the page). */
    talk: choice(["off", "hold", "handsFree"], { durable: true }),
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
      s.phase === "armed" ? { phase: "turn" } : s.phase === "turn" ? { phase: "armed" } : null,
    /** Enter — send the turn; the seat stays armed (divergence 2, decided).
     * Deliberately live while PAUSED: pausing and then sending what you have
     * is the point (owner, 2026-07-30). */
    send: (s) => (s.phase === "turn" ? { phase: "armed" } : null),
    /** ⏸ / `b` — toggle the collection pause (owner, 2026-07-30). Only in a
     * turn; the exclude resets it on exit so no turn opens pre-paused. */
    pause: (s) => (s.phase === "turn" ? { paused: !(s.paused as boolean) } : null),
    /** The explicit cancel cap — its OWN command, not a second route through
     * the `turn` toggle: distinct in traces, and the panel's content-ful
     * confirm gate names commands (owner, 2026-07-30). The verb effects treat
     * it like escape: leaving the turn cancels the thread. */
    cancelTurn: (s) => (s.phase === "turn" ? { phase: "armed" } : null),
    /** d — disarm from anywhere in-turn (same hard disarmed as everything). */
    disarm: () => ({ phase: "disarmed" }),
    // NOTE: `tweak` is GONE (C3′, owner 2026-07-25). It existed to escape
    // in-turn interference; now interference is precise (a claimed key SET
    // while armed, wholesale only in a turn, pointer only under explicit
    // modes), and DISARM is the escape hatch.
    // The three page-pointer tools are MUTUALLY EXCLUSIVE (owner, 2026-07-16):
    // pencil, area, and jump each own the page pointer with a full-viewport
    // overlay, so at most one is on. Turning any ON clears the other two; the
    // reducer expresses the exclusion directly (an exclude can't — it can't say
    // "the last one pressed wins"). Turning OFF just clears itself.
    /** k — toggle pencil markup mode (standing; the surface engages while
     * armed or in a turn — C2: markup is a SOURCE, not a turn perk). */
    pencil: (s): StatePatch =>
      s.pencil ? { pencil: false } : { pencil: true, region: false, jump: false },
    /** o — toggle the oracle session (standing, armed-scope). Taking it ON
     * takes the SINK, which is what pauses an open turn; turning it off hands
     * the sink back. Refused while disarmed (there is nothing to talk over);
     * the world's gates — a channel to mint through, a mic that was not
     * refused — ride `available` below. */
    oracle: (s) => (s.phase === "disarmed" ? null : { oracle: !(s.oracle as boolean) }),
    /** The oracle's park toggle — gate the mic, keep the session. */
    oraclePark: (s) => (s.oracle === true ? { oracleParked: !(s.oracleParked as boolean) } : null),
    /** v — toggle video sampling (standing; the claim gates on turn). */
    video: (s) => ({ video: !(s.video as boolean) }),
    /** f — flip the cadence. */
    fpsMode: (s) => ({ videoMode: s.videoMode === "smart" ? "constant" : "smart" }),
    /** Space down — open a hold-to-talk window (starts unmuted). Gated on the
     * SINK, not the phase: a hold is a gesture, and a gesture with no consumer
     * is nothing — refused while paused, live again on resume. */
    talkPress: (s) =>
      sink(s) !== undefined && s.talk === "off" ? { talk: "hold", micMuted: false } : null,
    /** Space up — ends only a HOLD window (hands-free ignores it). */
    talkRelease: (s) => (s.talk === "hold" ? { talk: "off" } : null),
    /** h — toggle hands-free talk (starts unmuted). ARMED-scope since C3′:
     * the mode stands with no turn open (nothing records until a consumer
     * exists — the window derives in client.ts); a turn opening routes it to
     * the transcriber/linter. */
    handsFree: (s) =>
      s.phase === "disarmed"
        ? null
        : s.talk === "handsFree"
          ? { talk: "off", micMuted: false }
          : { talk: "handsFree", micMuted: false },
    /** m — mute/unmute, only while a talk window is open. */
    mute: (s) => (s.talk !== "off" ? { micMuted: !(s.micMuted as boolean) } : null),
    /** ? — the keymap table. */
    help: (s) => ({ help: !(s.help as boolean) }),

    /** The wire closed the thread under us (idle timeout, server end). */
    turnEnded: (s) => (s.phase === "turn" ? { phase: "armed" } : null),

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
   * turn), then the phase rung (turn → armed → disarmed — no floor).
   * This is what dissolves the old region/jump Escape split-brain: the tool is
   * mode-engine state now, so ONE Escape source unwinds it — the page overlay no
   * longer runs its own private Escape listener. (area and jump are mutually
   * exclusive, so at most one of these two ever steps.) */
  escOrder: ["help", "region", "jump", "phase"],

  excludes: [
    // ONE disarmed, and it is HARD (owner, 2026-07-13; widened in C3′):
    // however you get there — the d key, the arm toggle, Esc unwinding the
    // last rung — every standing MODE clears: pencil, jump, and hands-free
    // talk (mute cascades via mute-needs-talk below). Declared once as an
    // invariant, not remembered per route. (Standing video/videoMode survive
    // disarm, as in the retired client.)
    {
      name: "disarmed-is-hard",
      when: (s) => s.phase === "disarmed",
      // …and the ORACLE (O3a): a live WebRTC session with an open mic must
      // never outlive disarm — that is the whole point of the escape hatch.
      set: { pencil: false, jump: false, talk: "off", oracle: false },
    },
    // Park is a property OF a session: no oracle, nothing to park.
    {
      name: "park-needs-oracle",
      when: (s) => s.oracle !== true && s.oracleParked === true,
      set: { oracleParked: false },
    },
    // Pause is a property OF a turn: leaving the turn (send, cancel, esc,
    // disarm) resets it, so no turn ever opens pre-paused (owner, 2026-07-30).
    {
      name: "pause-needs-turn",
      when: (s) => s.phase !== "turn" && s.paused === true,
      set: { paused: false },
    },
    // The area drag fires a shot into the turn, so anything that stops the turn
    // collecting clears it — leaving the turn, PAUSING it, or the ORACLE taking
    // the sink (a live crosshair over a suspended turn would shoot into it via
    // the regionDrag pump). Was `area-needs-turn` until the pause slice
    // generalized the term; `contributesToTurn` is where O3d widens it to the
    // oracle. Jump left this family in C3′ — an EDITOR act, armed-scope like
    // pencil (disarm clears it, above).
    {
      name: "area-needs-a-sink",
      when: (s) => !contributesToTurn(s) && s.region === true,
      set: { region: false },
    },
    // A HOLD is a gesture into the sink — you can no longer be "holding" once
    // nothing consumes it: turn gone, or turn paused. (Hands-free is a
    // STANDING mode since C3′ and survives both; only disarm ends it.) Was
    // `hold-needs-turn` until the pause slice.
    {
      name: "hold-needs-a-sink",
      when: (s) => sink(s) === undefined && s.talk === "hold",
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
   * the channel gate on arming. Everything else — pencil/send/mute/turn
   * disabled while disarmed, escape at the floor — derives from the dry-run.
   */
  available: {
    // Arming needs a channel. Note the shape: you can always arm DOWN
    // (disarm), whatever the world says.
    arm: (s, ctx) => s.phase !== "disarmed" || ctx.connected,
    // The oracle needs a channel to mint its credential through, and a mic
    // that was not REFUSED (O3a). `micGranted: undefined` means nobody has
    // asked yet — gating on that would dead-end the cap before the browser
    // ever got the chance, so only a definitive `false` refuses. Turning the
    // session OFF is always allowed (never stranded, like every other mode).
    oracle: (s, ctx) => s.oracle === true || (ctx.connected && ctx.micGranted !== false),
    // NOTE deliberately NO `turn` gate: a turn is a WIRE concept — talk and
    // text work grantless — so armed → turn derives from the reducer. The
    // capture GRANT gates the capture-dependent acts individually (below);
    // the invocation gesture mints it (found live: gating the turn cap on
    // the grant dead-ended the bar for anyone who armed via the cap).
    // …and only while the tab in view IS the granted tab: after a tab switch
    // the grant persists on the old tab, and shooting a tab you are not
    // looking at would contradict the hollow ring saying "no pixels here".
    // (Grantless hosts keep the two in lockstep, so this never bites there.)
    // …and only into a live SINK (the pause slice): a paused turn refuses the
    // contribution acts at the machine, so caps, keys, the remote bar, and
    // agent writes all meet the same answer (BEHAVIOR.md).
    shot: (s, ctx) =>
      contributesToTurn(s) && ctx.grantedTab !== undefined && ctx.grantedTab === ctx.activeTab,
    // The area drag is pixels too — turning it ON wants the same grant as a shot;
    // turning it OFF is always allowed (so a lost grant can't strand you in area
    // mode — you can always toggle back out, and Esc bypasses `available`).
    region: (s, ctx) =>
      s.region === true ||
      (contributesToTurn(s) && ctx.grantedTab !== undefined && ctx.grantedTab === ctx.activeTab),
    // Selection and clear are PAGE acts, not pixel acts (owner, 2026-07-14):
    // they ride the content script / bootstrap, which follows the tab in
    // view — no grant involved. Only pixels (shot, the stream, sampling) need
    // the invocation-gated grant. This is the tab-switch friction fix: under
    // MV3, switching tabs darkens CAPTURE only, and the hollow ring says how
    // to re-grant. The doctrine: the page transport follows the tab in view;
    // pixels follow the grant.
    // …and only when the page actually HAS one (owner, 2026-07-14): a
    // selection pull with nothing selected is a guaranteed miss — the cap
    // grays and its tooltip points at selecting something first.
    selection: (s, ctx) =>
      contributesToTurn(s) && ctx.activeTab !== undefined && ctx.selectionPresent,
    // Jump-to-editor is a PAGE act on instrumented pages only: the picker
    // reads the aiui stamps and source root, so a page without `__AIUI__`
    // grays the cap — the gate IS the feature detection (owner, 2026-07-15).
    // ARMED-scope since C3′ (an editor act, not a prompt act).
    jump: (s, ctx) =>
      s.jump === true ||
      ((s.phase === "turn" || s.phase === "armed") && ctx.activeTab !== undefined && ctx.aiuiPage),
    // Pencil markup is a PAGE act (the surface follows the tab in view, no grant
    // — a mouse, a stylus, and the iPad's strokes all land in-page). Its clear
    // rides the MODE, not the turn (C2, owner 2026-07-25 — superseding the
    // in-a-turn gate of 2026-07-16): the owner's founding complaint was having
    // to open a turn just to clear ink. Enabled while pencil mode is on, armed
    // or in-turn. Vanish/fade are config controls, not commands.
    pencilClear: (s, ctx) =>
      (s.phase === "turn" || s.phase === "armed") &&
      s.pencil === true &&
      ctx.activeTab !== undefined,
  },
};
