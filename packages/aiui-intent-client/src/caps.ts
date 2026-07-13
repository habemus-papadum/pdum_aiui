/**
 * caps.ts — the command bar, declared as a TREE (owner review 2026-07-13):
 * root = arm · step out · help; arming reveals the turn tier; engaging a cap
 * reveals its children (ink → clear/vanish/fade, hands-free → mute, video →
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
    command: "arm",
    hint: { key: "⏻", label: "armed" },
    litWhen: ({ state }) => state.phase !== "disarmed",
    children: [
      {
        command: "turn",
        hint: { key: "⌘B", label: "turn" },
        litWhen: ({ state }) => inTurn(state.phase),
        children: [
          {
            command: "ink",
            hint: { key: "i", label: "ink", icon: "✏️" },
            litWhen: ({ state }) => state.ink === true,
            children: [
              { command: "clear", hint: { key: "c", label: "clear", icon: "🧹" } },
              { kind: "widget", control: "inkVanish", widget: "toggle", label: "vanish" },
              {
                kind: "widget",
                control: "inkFade",
                widget: "slider",
                label: "fade",
                showWhen: ({ state }) => state.ink === true,
              },
            ],
          },
          { command: "shot", hint: { key: "s", label: "shot", icon: "🖼" } },
          {
            command: "selection",
            hint: { key: "a", label: "selection", icon: "📋" },
            litWhen: ({ ctx }) => ctx.selectionPresent,
          },
          {
            command: "tweak",
            hint: { key: "t", label: "tweak", icon: "🔧" },
            litWhen: ({ state }) => state.phase === "tweak",
          },
          {
            command: "handsFree",
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
            command: "video",
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

/** The standing config strip (the old panel's bottom bar): read at
 * thread-open by the Phase-2 lanes; visible and settable now. */
export const configBar: readonly BarNode<IntentContext>[] = [
  { kind: "widget", control: "stt", widget: "select", label: "stt" },
  { kind: "widget", control: "linter", widget: "select", label: "linter" },
  { kind: "widget", control: "logLevel", widget: "select", label: "log" },
  { kind: "widget", control: "shotFlash", widget: "toggle", label: "shot flash" },
];
