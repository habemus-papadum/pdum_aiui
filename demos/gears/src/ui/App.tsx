/**
 * App.tsx — Layer 4: the application shell for the gear studio.
 *
 * Overview first: the meshing assembly (the star), its controls, and a scrub.
 * Then the single-tooth studio. Components stay pure readers of the cell graph
 * (graph.ts) and the control surface (store.ts).
 */
import { CellView, ControlSlider, ControlToggle } from "@habemus-papadum/aiui-viz";
import { rad2deg } from "../model/gear";
import { graph } from "../model/graph";
import {
  addendum,
  dedendum,
  driveAngle,
  module as moduleCtl,
  pressureAngle,
  rpm,
  running,
  showConstruction,
  showContact,
  teethA,
  teethB,
} from "../model/store";
import { GearMesh } from "./GearMesh";
import { ToothStudio } from "./ToothStudio";

function Readouts() {
  return (
    <CellView of={graph().mesh} label="meshing">
      {(m) => (
        <div class="readouts">
          <div>
            <span class="rd-num">{m().ratio.toFixed(2)}:1</span>
            <span class="rd-lbl">gear ratio</span>
          </div>
          <div>
            <span class="rd-num">{m().contactRatio.toFixed(2)}</span>
            <span class="rd-lbl">contact ratio</span>
          </div>
          <div>
            <span class="rd-num">{m().center.toFixed(1)}</span>
            <span class="rd-lbl">centre dist (mm)</span>
          </div>
          <div>
            <span class="rd-num">{m().basePitch.toFixed(1)}</span>
            <span class="rd-lbl">base pitch (mm)</span>
          </div>
        </div>
      )}
    </CellView>
  );
}

export function App() {
  return (
    <div class="gears">
      <header class="masthead">
        <h1>Gear Studio</h1>
        <p class="muted">
          Two involute gears in kinematic mesh. Gear B is locked to gear A by the ratio and phase,
          so the teeth stay engaged at every angle — the contact point rides the fixed{" "}
          <span class="accent">line of action</span>, and its common normal (the contact force
          direction) never rotates.
        </p>
      </header>

      {/* ── the assembly (overview) ─────────────────────────────────────── */}
      <section id="assembly" class="panel">
        <div class="stage">
          <CellView of={graph().scene} label="assembly">
            {(v) => <GearMesh scene={v()} />}
          </CellView>
        </div>
        <Readouts />

        <div class="controls">
          <div class="control-row">
            <ControlToggle of={running} label={running.get() ? "pause" : "play"} />
            <ControlSlider of={rpm} label="speed" format={(v) => `${v} rpm`} />
          </div>
          <ControlSlider of={driveAngle} label="drive angle" format={(v) => `${v.toFixed(0)}°`} />
          <div class="control-grid">
            <ControlSlider of={teethA} label="teeth · A" format={(v) => `${v}`} />
            <ControlSlider of={teethB} label="teeth · B" format={(v) => `${v}`} />
            <ControlSlider of={pressureAngle} label="pressure angle" format={(v) => `${v}°`} />
            <ControlSlider of={moduleCtl} label="module" format={(v) => `${v} mm`} />
            <ControlSlider of={addendum} label="addendum" format={(v) => `${v.toFixed(2)}×m`} />
            <ControlSlider of={dedendum} label="dedendum" format={(v) => `${v.toFixed(2)}×m`} />
          </div>
          <div class="control-row">
            <ControlToggle of={showConstruction} label="construction" />
            <ControlToggle of={showContact} label="contact + normal" />
          </div>
        </div>
      </section>

      {/* ── the single tooth & its negative ─────────────────────────────── */}
      <section id="tooth" class="panel">
        <h2>One tooth & its negative</h2>
        <p class="muted">
          A tooth (filled) and the space beside it (background) — the cavity a mating tooth drops
          into. The flanks are involutes of the base circle; drag the pressure angle to watch them
          lean.
        </p>
        <ToothStudio />
      </section>

      <footer class="muted foot">
        Involute geometry · {rad2deg(Math.PI).toFixed(0)}° = π · a sandbox to grow.
      </footer>
    </div>
  );
}
