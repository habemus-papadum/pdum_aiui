/**
 * Capture: shots + ink, panel-first (proposal §13.5 — armed carries no mode;
 * every capture act is explicit). The shot button captures the active tab
 * whole-viewport via the SW/offscreen tabCapture path; the ink toggle enters
 * ink mode on the active tab's content script. Both arm the engine and open
 * the turn on their first contentful act — the orchestration lives in
 * main.tsx (this pane is view-only, like TurnPane).
 */

import { composeIntent, type Engine } from "@habemus-papadum/aiui-dev-overlay/intent-pipeline";
import { Pane } from "@habemus-papadum/aiui-webext";
import { For, Show } from "solid-js";

export interface CapturePaneProps {
  engine: Engine;
  /** Bumped by the host after every engine event (drives re-derivation). */
  rev: () => number;
  /** Take one whole-viewport shot of the active tab (main.tsx's takeShot). */
  onShot: () => void;
  /** Ink mode: on = the active tab's content script holds an ink surface. */
  inkOn: () => boolean;
  onInkToggle: () => void;
  /** Erase the strokes (mode exit deliberately does NOT — see main.tsx). */
  onInkClear: () => void;
  /** The capture status line (invocation failures land here). */
  status: () => string;
}

export function CapturePane(props: CapturePaneProps) {
  const shots = () => {
    props.rev(); // subscribe
    return props.engine.threadOpen
      ? composeIntent(props.engine.events).items.filter((item) => item.kind === "shot")
      : [];
  };

  const hint = () =>
    props.inkOn() ? "ink on" : shots().length > 0 ? `${shots().length} shot(s)` : "idle";

  return (
    <Pane title="Capture" hint={hint()}>
      <div class="row">
        <button type="button" class="chan" onClick={() => props.onShot()}>
          shot
        </button>
        <button
          type="button"
          class={props.inkOn() ? "chan ink-on" : "ghost"}
          onClick={() => props.onInkToggle()}
        >
          {props.inkOn() ? "ink mode ✓" : "ink mode"}
        </button>
        <Show when={props.inkOn()}>
          <button type="button" class="ghost" onClick={() => props.onInkClear()}>
            clear ink
          </button>
        </Show>
      </div>
      <Show when={shots().length > 0}>
        <div class="thumbs">
          <For each={shots()}>
            {(shot) => (
              <Show
                when={shot.thumb !== undefined}
                fallback={<span class="chip">{shot.marker}</span>}
              >
                <img src={shot.thumb} alt={shot.marker ?? "shot"} title={shot.marker} />
              </Show>
            )}
          </For>
        </div>
      </Show>
      <div class="kv">{props.status()}</div>
      <div class="kv">
        shots need invocation: click the aiui toolbar button once on a tab (per visit) before
        capturing it
      </div>
    </Pane>
  );
}
