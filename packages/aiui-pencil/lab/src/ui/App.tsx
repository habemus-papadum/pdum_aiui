/**
 * App.tsx — Pencil Lab.
 *
 * Draw on the pad. Move the knobs. The strokes you already drew **re-plan under
 * you** — which is the entire point: tuning a pencil by re-drawing a stroke you
 * can never draw the same way twice is not tuning, it is guessing.
 */

import { guardPenControls } from "@habemus-papadum/aiui-pencil";
import { adopt } from "@habemus-papadum/aiui-viz";
import type { JSX } from "@solidjs/web";
import { paper } from "../model/store";
import { CaptureReview } from "./CaptureReview";
import { InkData } from "./InkData";
import { Params } from "./Params";
import { PenPad } from "./PenPad";
import { Readout } from "./Readout";
import { SceneControls } from "./SceneControls";

export function App(): JSX.Element {
  return (
    <main class="lab">
      <header class="lab-header">
        <h1>Pencil Lab</h1>
        <p>
          Draw over the reference page, then move the page and the ink together. Compare scrolling,
          pinch zoom, rotation, and content reflow. The controls and measurements scroll separately.
        </p>
      </header>

      <div class="lab-body">
        <PenPad />
        {/* Keyboard focus enables native PageDown/End scrolling within this pane. */}
        <aside
          class="lab-side"
          aria-label="Pencil controls and measurements"
          tabindex={0}
          ref={adopt((element) => guardPenControls(element, () => paper.input))}
        >
          <SceneControls />
          <Readout />
          <InkData />
          <CaptureReview />
          <Params />
        </aside>
      </div>
    </main>
  );
}
