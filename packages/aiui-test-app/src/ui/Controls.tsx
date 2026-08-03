/**
 * Controls.tsx — the whole deliberate control surface: one slider (sample
 * count), one backend switch, three verbs. The mixture itself has NO sliders —
 * it is drawn, not dialed.
 */
import { ControlSlider } from "@habemus-papadum/aiui-viz";
import { clearAction, reseedAction, undoAction } from "../model/graph";
import { backend, ellipses, sampleCount, webgpuAvailable } from "../model/store";

export function Controls() {
  return (
    <section class="panel controls">
      <h2>sampler</h2>
      <ControlSlider of={sampleCount} label="samples" />

      <div class="seg" data-control={backend.name} title={backend.description}>
        <span class="slider-label">EM backend</span>
        <div class="seg-buttons">
          <button
            type="button"
            class={backend.get() === "js" ? "seg-btn seg-btn-on" : "seg-btn"}
            onClick={() => backend.set("js")}
          >
            js
          </button>
          <button
            type="button"
            class={backend.get() === "webgpu" ? "seg-btn seg-btn-on" : "seg-btn"}
            disabled={!webgpuAvailable}
            title={webgpuAvailable ? undefined : "this browser exposes no WebGPU adapter"}
            onClick={() => backend.set("webgpu")}
          >
            webgpu
          </button>
        </div>
      </div>

      <div class="btn-row">
        <button
          type="button"
          class="btn btn-outline"
          disabled={ellipses.get().length === 0}
          onClick={() => reseedAction.run()}
        >
          reseed
        </button>
        <button
          type="button"
          class="btn btn-outline"
          disabled={ellipses.get().length === 0}
          onClick={() => undoAction.run()}
        >
          undo
        </button>
        <button
          type="button"
          class="btn btn-outline"
          disabled={ellipses.get().length === 0}
          onClick={() => clearAction.run()}
        >
          clear
        </button>
      </div>
    </section>
  );
}
