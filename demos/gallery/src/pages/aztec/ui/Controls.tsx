/**
 * Controls.tsx — the fold, watchable. Target order and animation speed are
 * sliders over durable signals; play/pause and regrow drive the run; the scrub
 * slider moves the playhead through the recorded ring so you can walk the
 * arctic circle in and back out by hand.
 */
import { ControlSlider, ControlToggle } from "@habemus-papadum/aiui-viz";
import { Show } from "solid-js";
import { aztecGraph } from "../graph";
import { fps, frameIndex, frames, playing, regrow, showCircle, targetN } from "../store";

export function Controls() {
  const paused = () => !playing.get();
  const atEnd = () => frameIndex.get() >= frames.frames.length - 1;
  const play = () => {
    if (atEnd()) frameIndex.set(0);
    playing.set(true);
  };
  const shuffle = () => aztecGraph().shuffle;
  const scrubMax = () => Math.max(0, frames.frames.length - 1);

  return (
    <div class="controls panel">
      <div class="controls-grid">
        <ControlSlider of={targetN} label="order n" format={(v) => `AD(${v})`} />
        <ControlSlider of={fps} label="speed" format={(v) => `${v} steps/s`} />
      </div>

      <label class="slider aztec-scrub">
        <span class="slider-label">
          fold <b>{frames.at(frameIndex.get())?.n ?? "—"}</b>
          <span class="dim"> / {frames.last()?.n ?? "—"}</span>
        </span>
        <input
          type="range"
          name="fold"
          min={0}
          max={scrubMax()}
          step={1}
          value={Math.min(frameIndex.get(), scrubMax())}
          onInput={(e) => {
            playing.set(false);
            frameIndex.set(e.currentTarget.valueAsNumber);
          }}
        />
      </label>

      <div class="controls-buttons">
        <button type="button" class="btn" onClick={() => (paused() ? play() : playing.set(false))}>
          <Show when={paused()} fallback={<>‖ pause</>}>
            ▶ play
          </Show>
        </button>
        <button type="button" class="btn" onClick={() => regrow()}>
          ↺ regrow
        </button>
        <ControlToggle of={showCircle} label="arctic circle" />
        <span class="panel-sub aztec-status">
          <Show when={shuffle()?.loading()} fallback={<>grown</>}>
            growing… {Math.round((shuffle()?.progress() ?? 0) * 100)}%
          </Show>
        </span>
      </div>
    </div>
  );
}
