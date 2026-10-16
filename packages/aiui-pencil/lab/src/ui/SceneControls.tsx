/** View transformations and deliberate content-reflow experiments. */
import { ControlSelect, ControlSlider, ControlToggle } from "@habemus-papadum/aiui-viz";
import { type JSX, Show } from "@solidjs/web";
import {
  contentWidth,
  linkContent,
  navigationEnabled,
  navigationTarget,
  pencilMode,
  rotationEnabled,
  scene,
  sceneMappingValid,
  sceneState,
  touchStatus,
  zoomEnabled,
} from "../model/store";

export function SceneControls(): JSX.Element {
  const navigate = (dx: number, dy: number, scale = 1, rotation = 0) => {
    if (!linkContent.get() && navigationTarget.get() === "content") {
      scene.navigateContent(dx, dy, scale, rotation);
    } else {
      scene.navigate(dx, dy, scale, rotation);
    }
  };
  return (
    <section class="panel scene-controls" aria-label="Scene navigation">
      <h2>Scene navigation</h2>
      <div class="checks">
        <ControlToggle of={pencilMode} label="Pencil mode" />
        <ControlToggle of={navigationEnabled} label="Two-finger navigation" />
        <ControlToggle of={zoomEnabled} label="Pinch zoom" />
        <ControlToggle of={rotationEnabled} label="Twist rotation" />
      </div>
      <p class="hint">
        Pencil mode is on initially: draw with a pen or mouse; use two fingers to pan, pinch, and
        twist. Navigation pauses while the pen touches the surface.
      </p>
      <p class="hint" data-touch-status>
        {touchStatus.get()}
      </p>
      <div class="scene-link">
        <ControlToggle of={linkContent} label="Link ink and content" />
        <p class="hint">
          {linkContent.get()
            ? "Ink and the page use the same view. Scrolling moves both."
            : "Unlinked: choose which layer the pan, zoom, and rotation buttons move. Gestures move ink; scrolling moves the page. Linking aligns their views again."}
        </p>
        <Show when={!linkContent.get()}>
          <ControlSelect
            of={navigationTarget}
            label="Button target"
            labels={{ ink: "Ink", content: "Reference page" }}
          />
        </Show>
      </div>
      <fieldset class="row" aria-label="Native scroll controls">
        <button type="button" class="btn" onClick={() => scene.scrollBy(-260)}>
          Scroll up
        </button>
        <button type="button" class="btn" onClick={() => scene.scrollBy(260)}>
          Scroll down
        </button>
      </fieldset>
      <fieldset class="row" aria-label="Pan controls">
        <button type="button" class="btn" onClick={() => navigate(-80, 0)}>
          Pan left
        </button>
        <button type="button" class="btn" onClick={() => navigate(80, 0)}>
          Pan right
        </button>
        <button type="button" class="btn" onClick={() => navigate(0, -80)}>
          Pan up
        </button>
        <button type="button" class="btn" onClick={() => navigate(0, 80)}>
          Pan down
        </button>
      </fieldset>
      <div class="row">
        <button type="button" class="btn" onClick={() => navigate(0, 0, 0.8)}>
          Zoom out
        </button>
        <button type="button" class="btn" onClick={() => navigate(0, 0, 1.25)}>
          Zoom in
        </button>
        <button type="button" class="btn" onClick={() => navigate(0, 0, 1, -Math.PI / 12)}>
          Rotate left
        </button>
        <button type="button" class="btn" onClick={() => navigate(0, 0, 1, Math.PI / 12)}>
          Rotate right
        </button>
        <button type="button" class="btn" onClick={() => scene.resetView()}>
          Reset view
        </button>
      </div>
      <p class="scene-readout" data-scene-readout>
        Scroll {Math.round(sceneState.get().scrollTop)} px · ink{" "}
        {sceneState.get().ink.scale.toFixed(2)}×{" / "}
        {Math.round(((sceneState.get().ink.rotation ?? 0) * 180) / Math.PI)}° · page{" "}
        {sceneState.get().content.scale.toFixed(2)}×{" / "}
        {Math.round(((sceneState.get().content.rotation ?? 0) * 180) / Math.PI)}°
      </p>
      <h3>Content layout</h3>
      <ControlSlider of={contentWidth} label="Content width" />
      <div class="row">
        <button
          type="button"
          class="btn"
          onClick={() => contentWidth.set(contentWidth.get() < 500 ? 640 : 360)}
        >
          Reflow content
        </button>
        <button
          type="button"
          class="btn"
          disabled={sceneMappingValid.get()}
          onClick={() => scene.resume()}
        >
          Resume at current coordinates
        </button>
      </div>
      <p class="hint" data-mapping-status>
        {sceneMappingValid.get()
          ? "Resize the content to wrap its text and rearrange its cards. Ink pauses when its anchors become uncertain."
          : "Content reflowed. Ink is retained and hidden. Resume explicitly to keep its existing coordinates; marks may no longer align."}
      </p>
    </section>
  );
}
