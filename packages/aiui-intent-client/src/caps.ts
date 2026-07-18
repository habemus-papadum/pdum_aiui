/**
 * caps.ts — the command bar, declared as a TREE (owner review 2026-07-13):
 * root = arm · step out · help; arming reveals the turn tier; engaging a cap
 * reveals its children (pencil → clear/vanish/fade, hands-free → mute, video →
 * cadence/rate). The projection flattens it into depth rows; a tap
 * dispatches the same command its key does.
 *
 * Rules carried from the review: labels are STABLE (lit carries "engaged");
 * enabled is DERIVED (the engine dry-runs the reducer; verbs gate via the
 * spec's `available`); widgets are control-bound descriptors, so the whole
 * config surface is visible now and cannot get lost on the road to parity.
 */

import type { BarNode } from "@habemus-papadum/aiui-viz/modal";
import type { IntentContext } from "./spec";

const inTurn = (phase: unknown): boolean => phase === "turn" || phase === "tweak";

/** The main bar: the mode tree. */
export const intentBar: readonly BarNode<IntentContext>[] = [
  {
    // No key: arming is a cap (or the activation gesture) — not a modal key.
    command: "arm",
    hint: { key: "", label: "armed", icon: "⏻" },
    litWhen: ({ state }) => state.phase !== "disarmed",
    children: [
      {
        // No key either: the activation shortcut is an imperative event
        // outside the modal keyboard system (see activation.ts) — it must
        // not masquerade as this cap's binding.
        command: "turn",
        hint: { key: "", label: "turn", icon: "💬" },
        litWhen: ({ state }) => inTurn(state.phase),
        children: [
          { command: "shot", hint: { key: "s", label: "shot", icon: "🖼" } },
          {
            command: "region",
            hint: { key: "a", label: "area", icon: "⛶" },
            litWhen: ({ state }) => state.region === true,
          },
          {
            command: "jump",
            hint: { key: "j", label: "jump", icon: "🎯" },
            litWhen: ({ state }) => state.jump === true,
          },
          {
            command: "selection",
            hint: { key: "p", label: "selection", icon: "📋" },
            litWhen: ({ ctx }) => ctx.selectionPresent,
          },
          {
            command: "tweak",
            hint: { key: "t", label: "tweak", icon: "🔧" },
            litWhen: ({ state }) => state.phase === "tweak",
          },
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
            // Remote: the iPad drives voice from across the room — its whole
            // point (a wired-up remote surface). No child (mute) is remote; the
            // subset is deliberately the engagement toggles (hands-free, video,
            // pencil below).
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
            // holding the iPad wants to toggle. Its cadence children stay
            // desktop-only (a slider can't wire; fpsMode isn't flagged).
            command: "video",
            remote: true,
            hint: { key: "v", label: "video", icon: "🎥" },
            litWhen: ({ state }) => state.video === true,
            children: [
              {
                command: "fpsMode",
                hint: { key: "f", label: "constant", icon: "⏱" },
                litWhen: ({ state }) => state.videoMode === "constant",
              },
              {
                kind: "widget",
                control: "videoPeriodSec",
                widget: "slider",
                label: "s/frame",
                showWhen: ({ state }) => state.videoMode === "constant",
              },
            ],
          },
          // The pencil markup surface (mouse + stylus locally, iPad remotely) —
          // a `k` on/off toggle that lights, revealing clear · vanish · fade
          // (owner, 2026-07-16).
          // Remote: the iPad IS the remote pencil — the person holding it must
          // be able to enter/leave ink mode without reaching for the desktop
          // (owner, 2026-07-17). Children stay desktop-only: the iPad strip
          // already carries its own undo/clear.
          {
            command: "pencil",
            remote: true,
            hint: { key: "k", label: "pencil", icon: "🖊" },
            litWhen: ({ state }) => state.pencil === true,
            children: [
              { command: "pencilClear", hint: { key: "c", label: "clear", icon: "🧹" } },
              { kind: "widget", control: "pencilVanish", widget: "toggle", label: "vanish" },
              {
                kind: "widget",
                control: "pencilFade",
                widget: "slider",
                label: "fade",
                showWhen: ({ state }) => state.pencil === true,
              },
            ],
          },
          { command: "send", hint: { key: "⏎", label: "send", icon: "📤" } },
        ],
      },
    ],
  },
  { command: "escape", hint: { key: "esc", label: "step out", icon: "✖" } },
  {
    command: "help",
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
];
