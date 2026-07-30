/**
 * caps.ts — the command bar, declared as a TREE (owner review 2026-07-13):
 * root = arm · step out · help; arming reveals the turn cap, the hoisted
 * contribution caps (shot · area · selection · push-to-talk — sink-gated,
 * owner 2026-07-30), and the standing modes; an open turn reveals its
 * lifecycle cluster (send · pause · cancel); engaging a cap reveals its
 * children (pencil → clear/vanish/fade, hands-free → mute, video →
 * cadence/rate). The projection flattens it into depth rows; a tap
 * dispatches the same command its key does.
 *
 * Rules carried from the review: labels are STABLE (lit carries "engaged");
 * enabled is DERIVED (the engine dry-runs the reducer; verbs gate via the
 * spec's `available`); widgets are control-bound descriptors, so the whole
 * config surface is visible now and cannot get lost on the road to parity.
 *
 * Two membership flags ride the nodes, both static and both absent-means-no:
 * `remote` (the iPad's bar-only subset) and — O3c, owner 2026-07-30 —
 * `oracle`, the caps a voice agent embedded in this panel may PRESS. Three
 * families deliberately carry no `oracle` flag: the turn LIFECYCLE (send is
 * irreversible and outward-facing; pause/cancel duplicate or discard what the
 * oracle already did by taking the sink), the LADDER (arm/disarm/escape/oracle
 * — each would end the session that is asking), and its own HEARING
 * (hands-free/mute/push-to-talk/park — the mic is the user's, and a model that
 * can gate its own input can lock itself out of the instruction that would
 * restore it). Everything else is a page, markup, or source act, and is fair
 * game.
 */

import { controlByName } from "@habemus-papadum/aiui-viz";
import type { BarNode } from "@habemus-papadum/aiui-viz/modal";
import type { IntentContext } from "./spec";

const inTurn = (phase: unknown): boolean => phase === "turn";

/** The main bar: the mode tree. */
export const intentBar: readonly BarNode<IntentContext>[] = [
  {
    // No key: arming is a cap (or the channel-connected edge — the client
    // arms itself on connect, client.ts) — not a modal key.
    command: "arm",
    hint: { key: "", label: "armed", icon: "⏻" },
    litWhen: ({ state }) => state.phase !== "disarmed",
    children: [
      {
        // No key either: the turn opens from this cap alone — the invocation
        // gesture is grant-only now (see activation.ts) and must not
        // masquerade as this cap's binding.
        //
        // The children are exactly the turn-LIFECYCLE cluster (owner,
        // 2026-07-30): send · pause · cancel, bracketed beside the lit 💬 cap
        // — what you do WITH the turn. The contribution caps (shot · area ·
        // selection · push-to-talk) were HOISTED to the armed tier below,
        // sink-gated (BEHAVIOR.md "The cluster and the hoist").
        command: "turn",
        hint: { key: "", label: "turn", icon: "💬" },
        litWhen: ({ state }) => inTurn(state.phase),
        children: [
          { command: "send", hint: { key: "⏎", label: "send", icon: "📤" } },
          {
            // Remote: pausing from the couch is the point (owner, 2026-07-30).
            command: "pause",
            remote: true,
            hint: { key: "b", label: "pause", icon: "⏸" },
            litWhen: ({ state }) => state.paused === true,
          },
          {
            // Deliberately NOT remote: the content-ful confirm gate lives in
            // the panel UI (panel.tsx), and a remote cap would bypass it.
            command: "cancelTurn",
            hint: { key: "", label: "cancel", icon: "🗑", tone: "danger" },
          },
        ],
      },
      // ── the hoisted contribution caps (owner, 2026-07-30): armed-tier so
      // the cluster above stays pure lifecycle, DIMMED unless a sink is live
      // (`available` reads sink()) — dim is REFUSED, not discouraged. The
      // same move C1/C2/C3′ made for video, pencil, and hands-free; the
      // oracle sink will light them with no turn open. ─────────────────────
      {
        // Remote (owner, 2026-07-25): a one-off screenshot from the couch.
        // Armed-tier since the hoist — the iPad's button exists whenever
        // armed and dims without a sink or when the grant isn't on the tab
        // in view (`available`).
        command: "shot",
        oracle: true,
        remote: true,
        hint: { key: "s", label: "shot", icon: "🖼" },
      },
      {
        command: "region",
        oracle: true,
        hint: { key: "a", label: "area", icon: "⛶" },
        litWhen: ({ state }) => state.region === true,
      },
      {
        command: "selection",
        oracle: true,
        hint: { key: "p", label: "selection", icon: "📋" },
        litWhen: ({ ctx }) => ctx.selectionPresent,
      },
      // NOTE: the tweak cap is GONE (C3′ — the phase died with it; disarm
      // is the escape hatch); jump/hands-free/video moved to this tier in
      // C3′ (standing modes, not turn perks).
      {
        // Push-to-talk: a HOLD cap — press opens the talk window, release
        // ends it; the identical commands Space uses. A separate
        // engagement affordance from hands-free; one exclusive talk
        // region underneath (a second window is unrepresentable).
        command: "talkPress",
        hold: { down: "talkPress", up: "talkRelease" },
        hint: { key: "␣", label: "push to talk", icon: "🎙" },
        litWhen: ({ state }) => state.talk === "hold",
      },
      {
        // The ORACLE (O3a, owner 2026-07-30): a standing armed-scope session
        // that TAKES THE SINK — an open turn pauses itself while it is on.
        // Remote, and strongly so: asking the oracle from across the room is
        // the case. Its child is park (mic gated, session open).
        command: "oracle",
        remote: true,
        hint: { key: "o", label: "oracle", icon: "🔮" },
        litWhen: ({ state }) => state.oracle === true,
        children: [
          {
            command: "oraclePark",
            remote: true,
            hint: { key: "", label: "park", icon: "⏯" },
            litWhen: ({ state }) => state.oracleParked === true,
          },
        ],
      },
      {
        // C3′: jump is an EDITOR act, armed-scope like pencil.
        command: "jump",
        oracle: true,
        hint: { key: "j", label: "jump", icon: "🎯" },
        litWhen: ({ state }) => state.jump === true,
      },
      {
        // Remote: the iPad drives voice from across the room — its whole
        // point. Standing mode since C3′: toggles while armed; the window
        // opens when a turn (the consumer) does. No child (mute) is remote.
        command: "handsFree",
        remote: true,
        hint: { key: "h", label: "hands-free", icon: "🎧" },
        litWhen: ({ state }) => state.talk === "handsFree",
        children: [
          {
            command: "mute",
            hint: { key: "m", label: "mute", icon: "🔇" },
            litWhen: ({ state }) => state.micMuted === true,
          },
        ],
      },
      {
        // Remote: whether the tab is being filmed is exactly what the person
        // holding the iPad wants to toggle. Standing source (C1); its cadence
        // children stay desktop-only (a slider can't wire; fpsMode unflagged).
        command: "video",
        oracle: true,
        remote: true,
        hint: { key: "v", label: "video", icon: "🎥" },
        litWhen: ({ state }) => state.video === true,
        children: [
          // The cadence, made READABLE (owner, 2026-07-25): a mode SELECT
          // (smart | constant — the videoMode agent control) replaces the
          // ambiguous "constant" cap whose unlit state didn't say "smart";
          // the period slider stays visible and DIMS unless constant is the
          // mode — the honest signal that smart never reads it (smart's
          // quiescence gate is its own fixed clock).
          { kind: "widget", control: "videoMode", widget: "select", label: "mode" },
          {
            kind: "widget",
            control: "videoPeriodSec",
            widget: "slider",
            label: "every",
            enabledWhen: ({ state }) => state.videoMode === "constant",
          },
        ],
      },
      // The pencil markup surface (mouse + stylus locally, iPad remotely) — a
      // `k` on/off toggle that lights, revealing clear · vanish · fade. Lives
      // on the ARMED tier since C2 (owner, 2026-07-25 — markup is a source):
      // togglable and clearable with no turn open, on the desktop bar and the
      // iPad's remote bar alike (the founding complaint was opening a turn
      // just to clear ink).
      // Remote: the iPad IS the remote pencil — the person holding it must
      // be able to enter/leave ink mode without reaching for the desktop
      // (owner, 2026-07-17). Children stay desktop-only: the iPad strip
      // already carries its own undo/clear.
      {
        command: "pencil",
        oracle: true,
        remote: true,
        hint: { key: "k", label: "pencil", icon: "🖊" },
        litWhen: ({ state }) => state.pencil === true,
        children: [
          {
            command: "pencilClear",
            oracle: true,
            hint: { key: "c", label: "clear", icon: "🧹" },
          },
          { kind: "widget", control: "pencilVanish", widget: "toggle", label: "vanish" },
          {
            // Visible with its siblings, DIMMED unless vanish is on (owner,
            // 2026-07-25): a live-looking fade slider with vanish off lied.
            kind: "widget",
            control: "pencilFade",
            widget: "slider",
            label: "fade",
            enabledWhen: () => controlByName("pencilVanish")?.get() === true,
          },
        ],
      },
    ],
  },
  { command: "escape", hint: { key: "esc", label: "step out", icon: "✖" } },
  {
    command: "help",
    oracle: true,
    hint: { key: "?", label: "help", icon: "❓" },
    litWhen: ({ state }) => state.help === true,
  },
];

/** The standing config strip: read at thread-open by the lanes
 * (lanes.ts binds stt/linter/shotFlash); visible and settable here. */
export const configBar: readonly BarNode<IntentContext>[] = [
  { kind: "widget", control: "stt", widget: "select", label: "stt" },
  { kind: "widget", control: "linter", widget: "select", label: "linter" },
  { kind: "widget", control: "logLevel", widget: "select", label: "log" },
  { kind: "widget", control: "shotFlash", widget: "toggle", label: "shot flash" },
  // The oracle's three tool groups (O3b/O3c). Visible even with no session —
  // they are standing settings, and seeing one off explains a refusal.
  { kind: "widget", control: "oraclePageTools", widget: "toggle", label: "app tools" },
  { kind: "widget", control: "oraclePanelTools", widget: "toggle", label: "panel tools" },
  { kind: "widget", control: "oracleFileTools", widget: "toggle", label: "file tools" },
];
