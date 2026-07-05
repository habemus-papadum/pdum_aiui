/**
 * Controls.tsx — the fold, watchable. Target order and animation speed are
 * sliders over durable signals; play/pause and regrow drive the run; the scrub
 * slider moves the playhead through the recorded ring so you can walk the
 * arctic circle in and back out by hand.
 */
import { Show } from "solid-js";
import { aztecGraph } from "../graph";
import { fps, frameIndex, frames, MAX_N, playing, regrow, showCircle, targetN } from "../store";

function Slider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
  onInput: (v: number) => void;
}) {
  const shown = () => (props.format ?? ((v: number) => String(v)))(props.value);
  return (
    <label class="slider">
      <span class="slider-label">
        {props.label} <b>{shown()}</b>
      </span>
      <input
        type="range"
        name={props.label}
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onInput={(e) => props.onInput(e.currentTarget.valueAsNumber)}
      />
    </label>
  );
}

export function Controls() {
  const paused = () => !playing.get();
  const atEnd = () => frameIndex.get() >= frames.frames.length - 1;
  const play = () => {
    if (atEnd()) frameIndex.set(0);
    playing.set(true);
  };
  const shuffle = () => aztecGraph()?.shuffle;
  const scrubMax = () => Math.max(0, frames.frames.length - 1);

  return (
    <div class="controls panel">
      <div class="controls-grid">
        <Slider
          label="order n"
          value={targetN.get()}
          min={1}
          max={MAX_N}
          step={1}
          format={(v) => `AD(${v})`}
          onInput={(v) => targetN.set(v)}
        />
        <Slider
          label="speed"
          value={fps.get()}
          min={1}
          max={30}
          step={1}
          format={(v) => `${v} steps/s`}
          onInput={(v) => fps.set(v)}
        />
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
        <label class="check">
          <input
            type="checkbox"
            name="arctic-circle"
            checked={showCircle.get()}
            onInput={(e) => showCircle.set(e.currentTarget.checked)}
          />
          arctic circle
        </label>
        <span class="panel-sub aztec-status">
          <Show when={shuffle()?.loading()} fallback={<>grown</>}>
            growing… {Math.round((shuffle()?.progress() ?? 0) * 100)}%
          </Show>
        </span>
      </div>
    </div>
  );
}
