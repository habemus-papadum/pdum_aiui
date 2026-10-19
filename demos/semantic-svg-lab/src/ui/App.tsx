import { CellView, ControlSlider, ControlToggle } from "@habemus-papadum/aiui-viz";
import { Show } from "solid-js";
import { graph } from "../model/graph";
import { labMode } from "../model/markup-store";
import {
  history,
  lensVisible,
  magnification,
  notice,
  redo,
  resetCircuit,
  resetView,
  undo,
  zoom,
} from "../model/store";
import { CirclePairLab } from "./CirclePairLab";
import { CircuitBoard } from "./CircuitBoard";
import { ContactLab } from "./ContactLab";
import { DCLab } from "./DCLab";
import { GuidedMarkup } from "./GuidedMarkup";
import { StaticsLab } from "./StaticsLab";
import { StructureLab } from "./StructureLab";

export function App() {
  return (
    <main class="svg-lab">
      <header class="svg-lab-header">
        <p class="svg-lab-eyebrow">Semantic SVG / experiments 01–07</p>
        <h1>
          {labMode.get() === "dc"
            ? "Trace a circuit, repair a connection"
            : labMode.get() === "structure"
              ? "Build a load path"
              : labMode.get() === "pair"
                ? "Two circles, one contact"
                : labMode.get() === "statics"
                  ? "Where the load goes"
                  : labMode.get() === "contact"
                    ? "When a circle meets a line"
                    : labMode.get() === "markup"
                      ? "From a mark to a change"
                      : "One circuit, several views"}
        </h1>
        <p class="svg-lab-lede">
          {labMode.get() === "dc"
            ? "Rewire a loaded voltage divider. Follow the same terminals through the schematic, electrical nets and current-balance equations."
            : labMode.get() === "structure"
              ? "Change the connections, inspect a joint, and repair the structure. The drawing, force view and equations follow the same objects."
              : labMode.get() === "pair"
                ? "Move one circle around another. Keep them tangent and follow the changing normal, contact point and tangent line."
                : labMode.get() === "statics"
                  ? "Move a load along a beam and watch its supports share the force. The drawing and equilibrium equations stay linked."
                  : labMode.get() === "contact"
                    ? "Move a circle, inspect its gap, and keep it tangent. The drawing and equation share one radius control."
                    : labMode.get() === "markup"
                      ? "Mark a circuit, keep the original evidence, and review a change together. A guided exercise with a scripted response."
                      : "A lens reveals what the drawing leaves implicit. Point through it, change a value, and follow the same object across every view."}
        </p>
      </header>
      <nav class="svg-lab-tabs" aria-label="Choose an experiment">
        <button
          type="button"
          class="btn btn-outline"
          aria-pressed={labMode.get() === "explore" ? "true" : "false"}
          onClick={() => labMode.set("explore")}
        >
          Circuit views
        </button>
        <button
          type="button"
          class="btn btn-outline"
          aria-pressed={labMode.get() === "markup" ? "true" : "false"}
          onClick={() => labMode.set("markup")}
        >
          Guided markup
        </button>
        <button
          type="button"
          class="btn btn-outline"
          aria-pressed={labMode.get() === "contact" ? "true" : "false"}
          onClick={() => labMode.set("contact")}
        >
          Contact geometry
        </button>
        <button
          type="button"
          class="btn btn-outline"
          aria-pressed={labMode.get() === "statics" ? "true" : "false"}
          onClick={() => labMode.set("statics")}
        >
          Beam statics
        </button>
        <button
          type="button"
          class="btn btn-outline"
          aria-pressed={labMode.get() === "pair" ? "true" : "false"}
          onClick={() => labMode.set("pair")}
        >
          Two circles
        </button>
        <button
          type="button"
          class="btn btn-outline"
          aria-pressed={labMode.get() === "structure" ? "true" : "false"}
          onClick={() => labMode.set("structure")}
        >
          Editable structure
        </button>
        <button
          type="button"
          class="btn btn-outline"
          aria-pressed={labMode.get() === "dc" ? "true" : "false"}
          onClick={() => labMode.set("dc")}
        >
          Editable circuit
        </button>
      </nav>
      <Show when={labMode.get() === "dc"}>
        <DCLab />
      </Show>
      <Show when={labMode.get() === "structure"}>
        <StructureLab />
      </Show>
      <Show when={labMode.get() === "pair"}>
        <CirclePairLab />
      </Show>
      <Show when={labMode.get() === "statics"}>
        <StaticsLab />
      </Show>
      <Show when={labMode.get() === "contact"}>
        <ContactLab />
      </Show>
      <Show when={labMode.get() === "markup"}>
        <GuidedMarkup />
      </Show>
      <Show when={labMode.get() === "explore"}>
        <section aria-label="Circuit lens experiment">
          <div class="svg-lab-toolbar">
            <ControlToggle of={lensVisible} label="Terminal lens" />
            <ControlSlider
              of={zoom}
              label="Drawing scale"
              format={(value) => `${value.toFixed(1)}×`}
            />
            <ControlSlider
              of={magnification}
              label="Lens scale"
              format={(value) => `${value.toFixed(1)}×`}
            />
            <div class="svg-lab-buttons">
              <button class="btn btn-outline" type="button" onClick={() => resetView.run()}>
                Reset view
              </button>
              <button
                class="btn btn-outline"
                type="button"
                disabled={!history.get().past.length}
                onClick={() => undo.run()}
              >
                Undo
              </button>
              <button
                class="btn btn-outline"
                type="button"
                disabled={!history.get().future.length}
                onClick={() => redo.run()}
              >
                Redo
              </button>
            </div>
          </div>
          <CellView of={graph().circuit} label="Preparing circuit">
            {(circuit) => <CircuitBoard circuit={circuit()} />}
          </CellView>
          <Show when={notice.get()}>
            <p role="status">{notice.get()}</p>
          </Show>
        </section>
        <section class="svg-lab-experiments" id="try-it">
          <h2>three things to try</h2>
          <div class="svg-lab-prompts">
            <div>
              <h3>Reveal a hidden connection</h3>
              <p>
                Move the lens over M1. Select its bulk terminal. Hide the lens: the selection and
                its connection to ground remain.
              </p>
            </div>
            <div>
              <h3>Edit one occurrence</h3>
              <p>
                Select R1’s value in the lens and apply a new resistance. A and B share a
                definition, but the other occurrence keeps its value. Undo restores the edit.
              </p>
            </div>
            <div>
              <h3>Keep your place</h3>
              <p>
                Zoom, pan, or navigate through the overview. The selected feature keeps its
                identity. Use Focus A or Focus B to bring a resistor under the lens.
              </p>
            </div>
          </div>
        </section>
      </Show>
      <Show when={labMode.get() === "explore" || labMode.get() === "markup"}>
        <footer class="svg-lab-footer">
          <p>
            Illustrative circuit · no electrical simulation. Circuit values are saved in this
            browser; undo history lasts for this session. Markup and captured requests are
            session-only.
          </p>
          <button class="btn btn-outline" type="button" onClick={() => resetCircuit.run()}>
            Restore fixture values
          </button>
        </footer>
      </Show>
    </main>
  );
}
