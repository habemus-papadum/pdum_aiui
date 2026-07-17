/**
 * strip.tsx — `<PencilStrip/>`: the tune strip, rendered FROM the joined
 * session's presentation (owner, 2026-07-17). This is where applications
 * genuinely differ, so nothing here is hardcoded per app:
 *
 *   tools    which ends of the instrument are offered (draw / erase)
 *   modes    which presets are offered (write / sketch)
 *   color    the brush color knob (a stroke override the host merges)
 *   size     the brush size knob (same)
 *   undo     ↩ lift the last stroke
 *   clear    ✕ the whole surface
 *
 * A single-entry group renders no buttons — a choice of one is not a choice.
 * The knobs default to "preset" (undefined): the host's own preset values
 * apply until the user moves a knob, and the ✕ reset beside each knob returns
 * to the preset.
 */

import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import type { PencilMode } from "../pencil";
import type { Tool } from "../surface";
import type { ResolvedPresentation } from "./presentation";

export interface PencilStripProps {
  presentation: ResolvedPresentation;
  penMode: boolean;
  tool: Tool;
  onTool: (tool: Tool) => void;
  mode: PencilMode;
  onMode: (mode: PencilMode) => void;
  /** undefined = the preset's own color/size. */
  color: string | undefined;
  onColor: (color: string | undefined) => void;
  size: number | undefined;
  onSize: (size: number | undefined) => void;
  onUndo: () => void;
  onClear: () => void;
}

const TOOL_LABEL: Record<Tool, string> = { draw: "✏️ draw", erase: "◻️ erase" };

export function PencilStrip(props: PencilStripProps): JSX.Element {
  const p = () => props.presentation;
  return (
    <div class="bar">
      <Show when={props.penMode}>
        <span
          class="pen-chip"
          title="a pencil was detected: fingers navigate, only the pencil inks"
        >
          ✍️ pencil
        </span>
      </Show>
      <Show when={p().tools.length > 1}>
        <For each={p().tools}>
          {(tool) => (
            <button type="button" data-lit={props.tool === tool} onClick={() => props.onTool(tool)}>
              {TOOL_LABEL[tool] ?? tool}
            </button>
          )}
        </For>
      </Show>
      <Show when={p().modes.length > 1}>
        <For each={p().modes}>
          {(mode) => (
            <button type="button" data-lit={props.mode === mode} onClick={() => props.onMode(mode)}>
              {mode}
            </button>
          )}
        </For>
      </Show>
      <Show when={p().color}>
        <label class="knob" title="brush color (✕ returns to the preset)">
          <input
            type="color"
            value={props.color ?? "#2b2b33"}
            onInput={(e) => props.onColor(e.currentTarget.value)}
          />
          <Show when={props.color !== undefined}>
            <button type="button" class="knob-reset" onClick={() => props.onColor(undefined)}>
              ✕
            </button>
          </Show>
        </label>
      </Show>
      <Show when={p().size}>
        <label class="knob" title="brush size (✕ returns to the preset)">
          <input
            type="range"
            min="1"
            max="24"
            step="0.5"
            value={props.size ?? 4}
            onInput={(e) => props.onSize(Number(e.currentTarget.value))}
          />
          <Show when={props.size !== undefined}>
            <button type="button" class="knob-reset" onClick={() => props.onSize(undefined)}>
              ✕
            </button>
          </Show>
        </label>
      </Show>
      <Show when={p().undo}>
        <button type="button" onClick={() => props.onUndo()}>
          ↩ undo
        </button>
      </Show>
      <Show when={p().clear}>
        <button type="button" onClick={() => props.onClear()}>
          ✕ clear
        </button>
      </Show>
    </div>
  );
}
