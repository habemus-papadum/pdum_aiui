/**
 * caps.ts — the command bar, declared (bar projection over the spec).
 *
 * Cap order is the decided one (old panel, final form): acts → talk/video →
 * send · esc · disarm · help. A cap dispatches the same command its key
 * does; lit/enabled/shown are derivations — the cap-inversion bug family
 * has no code left to live in.
 */

import type { BarInputs, CapSpec } from "@habemus-papadum/aiui-viz/modal";
import type { IntentContext } from "./spec";

type Inputs = BarInputs<IntentContext>;

const talking = ({ state }: Inputs): boolean => state.talk !== "off";

export const intentCaps: readonly CapSpec<IntentContext>[] = [
  {
    command: "ink",
    hint: ({ state }) => ({ key: "i", label: state.ink ? "ink off" : "ink", icon: "✏️" }),
    litWhen: ({ state }) => state.ink === true,
    reveals: "ink-fade",
  },
  {
    command: "shot",
    hint: { key: "s", label: "shot", icon: "🖼" },
  },
  {
    command: "selection",
    hint: { key: "a", label: "add selection", icon: "📋" },
    litWhen: ({ ctx }) => ctx.selectionPresent,
  },
  {
    command: "clear",
    hint: { key: "c", label: "clear ink", icon: "🧹" },
    showWhen: ({ state }) => state.ink === true,
  },
  {
    command: "tweak",
    hint: ({ state }) => ({
      key: "t",
      label: state.phase === "tweak" ? "resume (leave tweak)" : "tweak",
      icon: "🔧",
    }),
    litWhen: ({ state }) => state.phase === "tweak",
  },
  {
    command: "handsFree",
    hint: (inputs) => ({
      key: "h",
      label: inputs.state.talk === "handsFree" ? "stop hands-free" : "hands-free",
      icon: "🎧",
    }),
    litWhen: ({ state }) => state.talk === "handsFree",
  },
  {
    command: "mute",
    hint: ({ state }) => ({ key: "m", label: state.micMuted ? "unmute" : "mute", icon: "🔇" }),
    showWhen: talking,
    litWhen: ({ state }) => state.micMuted === true,
  },
  {
    command: "video",
    hint: ({ state, claims }) => ({
      key: "v",
      label:
        state.video && claims.videoSample?.phase === "pending"
          ? "video (warming…)"
          : state.video
            ? "video off"
            : "video",
      icon: "🎥",
    }),
    litWhen: ({ state }) => state.video === true,
    reveals: "video-cadence",
  },
  {
    command: "fpsMode",
    hint: ({ state }) => ({
      key: "f",
      label: state.videoMode === "smart" ? "constant rate" : "smart rate",
      icon: "⏱",
    }),
    showWhen: ({ state }) => state.video === true,
    litWhen: ({ state }) => state.videoMode === "constant",
  },
  {
    command: "send",
    hint: { key: "⏎", label: "send", icon: "📤" },
    showWhen: ({ state }) => state.phase === "turn" || state.phase === "tweak",
  },
  {
    command: "escape",
    hint: { key: "esc", label: "step out", icon: "✖" },
    showWhen: ({ state }) => state.phase === "turn" || state.phase === "tweak",
  },
  {
    command: "disarm",
    hint: { key: "d", label: "disarm", icon: "💤", tone: "danger" },
    showWhen: ({ state }) => state.phase !== "disarmed",
  },
  {
    command: "help",
    hint: { key: "?", label: "help", icon: "❓" },
    litWhen: ({ state }) => state.help === true,
  },
];
