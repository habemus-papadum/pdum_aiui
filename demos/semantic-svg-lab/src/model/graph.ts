import { inkSignals } from "@habemus-papadum/aiui-pencil/solid";
import { agentToolkit, cell, hotCellGraph, registerStandardTools } from "@habemus-papadum/aiui-viz";
import { onCleanup } from "solid-js";
import { circlePair } from "./circle-pair";
import { inspectPair, pairInput, pairScope } from "./circle-pair-store";
import { describeCircuit, resolveFeature } from "./circuit";
import { circleLineContact } from "./contact";
import { contactInput, contactScope, inspectContact } from "./contact-store";
import { analyzeDC } from "./dc-circuit";
import { dcInput, dcScope, inspectDC } from "./dc-store";
import { laterStrokes } from "./markup";
import { inkDocument, inspectMarkup, workflow } from "./markup-store";
import { solveBeam } from "./statics";
import { beamInput, inspectBeam, staticsScope } from "./statics-store";
import { appScope, history, inspectCircuit, selected } from "./store";
import { analyzeStructure } from "./structure";
import { inspectStructure, structureInput, structureScope } from "./structure-store";

export function buildGraph() {
  /** Circuit-derived data shared by all projections. Camera, lens and selection are not inputs. */
  const circuit = cell(
    () => ({ document: history.get().current }),
    ({ document }) => describeCircuit(document),
    { scope: appScope },
  );
  /** Inspection follows selection and the current circuit, independently of navigation. */
  const inspection = cell(
    () => ({ key: selected.get(), document: history.get().current }),
    ({ key, document }) => {
      const feature = resolveFeature(key);
      return {
        ...feature,
        revision: document.revision,
        resistance: document.stages[feature.ref.occurrence].resistance,
      };
    },
    { scope: appScope },
  );
  const ink = inkSignals(inkDocument);
  onCleanup(() => ink.dispose());
  /** Small coherent progress readout; no brush planning runs on live input. */
  const markup = cell(
    () => ({ snapshot: ink.snapshot(), evidence: workflow.get().evidence }),
    ({ snapshot, evidence }) => ({
      completed: snapshot.strokes.length,
      live: snapshot.live.length,
      later: evidence ? laterStrokes(evidence.ink, snapshot.strokes) : 0,
    }),
    { scope: appScope },
  );
  /** Contact geometry is independent of circuit, markup, and attention state. */
  const contact = cell(contactInput, circleLineContact, { scope: contactScope });
  const statics = cell(beamInput, solveBeam, { scope: staticsScope });
  const pair = cell(pairInput, circlePair, { scope: pairScope });
  const structure = cell(structureInput, analyzeStructure, { scope: structureScope });
  const dc = cell(dcInput, analyzeDC, { scope: dcScope });
  return { circuit, inspection, markup, contact, statics, pair, structure, dc };
}
export const graph = hotCellGraph(appScope.name, buildGraph, import.meta.hot);
// Vite discovers HMR boundaries lexically; the helper's runtime accept alone
// is invisible to its import analyzer. The helper still owns disposal/adoption.
if (import.meta.hot) import.meta.hot.accept();
export type AppGraph = ReturnType<typeof graph>;
const kit = agentToolkit(appScope.name, {
  brief:
    "Circuit lens experiment: two occurrences (a, b) of one common-source block. inspect-circuit discovers feature keys and revisions; select-feature selects across views; set-resistance edits one occurrence with a revision guard; undo/redo restore values. navigate and the zoom/magnification/lensVisible controls affect presentation only. The guided markup exercise uses begin-markup, capture-markup, review-markup and apply-markup; inspect-markup reports its phase and input gates. The response is scripted and no ink interpretation is performed. The contact experiment has contact/inspect, contact/move-circle, contact/hold-tangency and contact/reset; its shared numeric control is semantic-svg-lab/contact/radius. Beam statics exposes statics/inspect, statics/center-load and statics/reset; statics/load and statics/loadPosition are the shared drawing/equation controls. Circle-pair geometry uses pair/inspect, pair/move-circle, pair/set-pose, pair/hold-tangency and pair/align-centres. Its radiusA/radiusB controls live under semantic-svg-lab/pair/. The editable structure uses structure/inspect, structure/select, structure/edit (revision guarded), structure/undo and structure/redo. Scripted pencil proposals use structure/begin-brace, structure/preview-brace and structure/apply-brace. The editable DC circuit uses dc/inspect, dc/select, dc/edit, dc/undo, dc/redo, dc/place, dc/load-case and dc/begin-return, dc/preview-return, dc/apply-return. It solves a bounded ideal resistor network locally; there is no external simulator or agent runtime.",
});
registerStandardTools(kit);
kit.registerReporter("circuit", () => inspectCircuit.run());

kit.registerReporter("markup", () => inspectMarkup.run());

kit.registerReporter("contact", () => inspectContact.run());

kit.registerReporter("statics", () => inspectBeam.run());

kit.registerReporter("pair", () => inspectPair.run());

kit.registerReporter("structure", () => inspectStructure.run());

kit.registerReporter("dc", () => inspectDC.run());
