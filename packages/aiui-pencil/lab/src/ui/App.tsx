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
import { InkData } from "./InkData";
import { Params } from "./Params";
import { PenPad } from "./PenPad";
import { Readout } from "./Readout";

export function App(): JSX.Element {
  return (
    <main class="lab">
      <header class="lab-header">
        <h1>Pencil Lab</h1>
        <p>
          One instrument. Pressure darkens and broadens it; laying it over turns the contact patch
          elliptical and it becomes charcoal. This page is the tuning rig — and, first,{" "}
          <b>the measurement</b>: open it on the iPad and find out what an Apple Pencil in Safari
          actually reports.
        </p>
      </header>

      <div class="lab-body">
        <PenPad />
        <aside
          class="lab-side"
          ref={adopt((element) => guardPenControls(element, () => paper.input))}
        >
          <Readout />
          <InkData />
          <Params />
        </aside>
      </div>
    </main>
  );
}
