import { chart } from "@habemus-papadum/aiui-design";
import { captureTargetProps } from "@habemus-papadum/aiui-screen-capture";
import {
  ScreenCaptureControl,
  ScreenCapturePreview,
  ScreenCaptureTarget,
} from "@habemus-papadum/aiui-screen-capture/widgets";
import { CellView, ControlSlider, ControlToggle } from "@habemus-papadum/aiui-viz";
import { onCleanup } from "solid-js";
import { graph } from "../model/graph";
import { capture, motion, overlap, targets, visible, width } from "../model/store";

export function App() {
  let area!: HTMLDivElement;
  const owned = new Map<string, HTMLElement>();
  const register = (id: string) => (element: HTMLDivElement) => {
    targets.set(id, element);
    owned.set(id, element);
  };
  onCleanup(() => {
    for (const [id, element] of owned) if (targets.get(id) === element) targets.delete(id);
  });
  return (
    <main
      class="screen-demo"
      style={{ "--screen-demo-blue": chart().blue, "--screen-demo-green": chart().green }}
    >
      <header>
        <p class="screen-demo-eyebrow">Browser instruments</p>
        <h1>Screen capture</h1>
        <p class="lede">
          A live view of a tab, window, or display. Narrow it to one element and watch the capture
          follow the page.
        </p>
      </header>
      <section class="screen-demo-controls" aria-label="Capture controls">
        <ScreenCaptureControl
          capture={capture}
          pickerRoot={() => area}
          targets={[
            { label: "Wave chart", element: () => targets.get("chart") },
            { label: "Field notes", element: () => targets.get("notes") },
          ]}
        />
      </section>
      <div class="screen-demo-workspace">
        <section aria-labelledby="screen-demo-targets">
          <h2 id="screen-demo-targets">capture targets</h2>
          <p class="screen-demo-instructions">
            Wave chart and Field notes are declared capture boundaries. In Element only, the picker
            selects the whole boundary; Region can select its individual contents. Share this tab
            and keep the target in view.
          </p>
          <div ref={area} class="screen-demo-targets">
            <div class="screen-demo-chart-wrap" style={{ width: `${width.get()}%` }}>
              <ScreenCaptureTarget
                ref={register("chart")}
                label="Wave chart"
                class="screen-demo-chart"
                style={{ visibility: visible.get() ? "visible" : "hidden" }}
              >
                <p class="screen-demo-eyebrow">Wave chart</p>
                <svg
                  viewBox="0 0 640 220"
                  role="img"
                  aria-label="Two waves and an animated scanning line"
                >
                  <path
                    class="screen-demo-grid"
                    d="M0 55H640 M0 110H640 M0 165H640 M80 0V220 M160 0V220 M240 0V220 M320 0V220 M400 0V220 M480 0V220 M560 0V220"
                  />
                  <path
                    class="screen-demo-wave"
                    d="M0 110 Q40 5 80 110 T160 110 T240 110 T320 110 T400 110 T480 110 T560 110 T640 110"
                  />
                  <path
                    class="screen-demo-wave secondary"
                    d="M0 110 Q80 200 160 110 T320 110 T480 110 T640 110"
                  />
                  <rect
                    class="screen-demo-scan"
                    x="0"
                    y="0"
                    width="3"
                    height="220"
                    style={{ "animation-play-state": motion.get() ? "running" : "paused" }}
                  />
                </svg>
                <p class="screen-demo-caption">A changing picture, inside a stable element.</p>
              </ScreenCaptureTarget>
              <div
                class="screen-demo-overlap"
                style={{ display: overlap.get() ? "block" : "none" }}
              >
                Sibling annotation
                <br />
                <small>Visible in Region; excluded by Element only.</small>
              </div>
            </div>
            <div class="screen-demo-knobs" data-screen-capture-ignore="">
              <ControlSlider of={width} label="Chart width" />
              <ControlToggle of={motion} label="Motion" />
              <ControlToggle of={overlap} label="Overlap" />
              <ControlToggle of={visible} label="Show chart" />
            </div>
            <div
              {...captureTargetProps("Field notes")}
              ref={register("notes")}
              class="screen-demo-notes"
            >
              <p class="screen-demo-eyebrow">Field notes</p>
              <h3>One selected area</h3>
              <p>
                A crop follows the element when it moves or resizes. Returning to Full surface
                restores the selected tab without another permission request.
              </p>
            </div>
          </div>
        </section>
        <section aria-labelledby="screen-demo-preview">
          <h2 id="screen-demo-preview">preview</h2>
          <ScreenCapturePreview capture={capture} />
        </section>
      </div>
      <section>
        <h2>capture state</h2>
        <CellView of={graph().status}>
          {(state) => (
            <dl class="screen-demo-state">
              <div>
                <dt>Capture</dt>
                <dd>{state().state}</dd>
              </div>
              <div>
                <dt>Surface</dt>
                <dd>{state().source?.surface ?? "—"}</dd>
              </div>
              <div>
                <dt>Area</dt>
                <dd>{state().crop?.label ?? "Full surface"}</dd>
              </div>
              <div>
                <dt>Track rate</dt>
                <dd>{state().settings?.frameRate?.toFixed(1) ?? "—"} fps</dd>
              </div>
            </dl>
          )}
        </CellView>
        <p class="screen-demo-footnote">
          Preview FPS measures frames shown here. A still image or a background tab can produce
          fewer frames. Element cropping requires browser support and capture of this tab; screen
          and window capture use the full selected surface.
        </p>
      </section>
    </main>
  );
}
