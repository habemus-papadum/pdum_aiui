import { createInkDocument } from "@habemus-papadum/aiui-pencil/core";
import { action, control } from "@habemus-papadum/aiui-viz";
import { flush } from "solid-js";
import { type Circuit, resolveFeature } from "./circuit";
import {
  type Evidence,
  type FrozenView,
  freezeView,
  laterStrokes,
  type MarkupWorkflow,
  proposalIsStale,
  propose,
} from "./markup";
import { appScope, history, selected, setResistance, undo } from "./store";

/** Choose among the circuit, markup, contact, statics and circle-pair experiments. */
export const labMode = control<
  "explore" | "markup" | "contact" | "statics" | "pair" | "structure" | "dc"
>({
  scope: appScope,
  value:
    new URLSearchParams(location.search).get("lab") === "dc"
      ? "dc"
      : new URLSearchParams(location.search).get("lab") === "structure"
        ? "structure"
        : new URLSearchParams(location.search).get("lab") === "pair"
          ? "pair"
          : new URLSearchParams(location.search).get("lab") === "statics"
            ? "statics"
            : new URLSearchParams(location.search).get("lab") === "contact"
              ? "contact"
              : new URLSearchParams(location.search).get("lab") === "markup"
                ? "markup"
                : "explore",
  options: ["explore", "markup", "contact", "statics", "pair", "structure", "dc"],
});
export const workflow = appScope.durableSignal<MarkupWorkflow>("markup-workflow", {
  phase: "choose",
});
export const inkDocument = appScope.durable("markup-ink", () =>
  createInkDocument({ historyLimit: 64 }),
);
/** Browser capabilities registered only while their component is mounted. They are never serialized. */
export const markupPorts = appScope.durable<{
  readView?: () => FrozenView;
  renderEvidence?: () => Evidence;
}>("markup-ports", () => ({}));

/** Freeze the selected resistor and the current view, then open the writing sheet. */
export const beginMarkup = action({
  scope: appScope,
  name: "begin-markup",
  run() {
    if (workflow.get().phase !== "choose")
      throw new Error("Finish or restart the current exercise first.");
    if (!markupPorts.readView) throw new Error("The circuit view is not ready yet.");
    const feature = resolveFeature(selected.get());
    if (feature.ref.part !== "R1" || feature.ref.feature !== "value")
      throw new Error("Select a resistor value in the drawing first.");
    const sheet = freezeView(markupPorts.readView());
    flush(() => workflow.set({ phase: "mark", sheet }));
    return { target: sheet.target, revision: sheet.circuit.revision };
  },
});
/** Freeze completed ink together with its original view. Later strokes never change this evidence. */
export const captureMarkup = action({
  scope: appScope,
  name: "capture-markup",
  run() {
    const state = workflow.get();
    if (state.phase !== "mark" || !state.sheet) throw new Error("Open the writing sheet first.");
    const snapshot = inkDocument.snapshot();
    if (snapshot.live.length) throw new Error("Lift the pen before capturing.");
    if (!snapshot.strokes.length) throw new Error("Add a mark before capturing.");
    if (!markupPorts.renderEvidence) throw new Error("The writing sheet is not ready yet.");
    const evidence = markupPorts.renderEvidence();
    flush(() =>
      workflow.set({ ...state, phase: "continue", evidence, proposal: propose(evidence.view) }),
    );
    return {
      strokes: evidence.ink.strokes.length,
      target: evidence.view.target,
      revision: evidence.view.circuit.revision,
    };
  },
});
/** After adding a newer mark, inspect the fixed scripted proposal on the live circuit. */
export const reviewMarkup = action({
  scope: appScope,
  name: "review-markup",
  run() {
    const state = workflow.get();
    if (state.phase !== "continue" || !state.evidence)
      throw new Error("Capture the request first.");
    if (inkDocument.snapshot().live.length) throw new Error("Lift the pen before continuing.");
    if (!laterStrokes(state.evidence.ink, inkDocument.snapshot().strokes))
      throw new Error("Add one more mark to test that newer ink is preserved.");
    flush(() => workflow.set({ ...state, phase: "review" }));
    return { phase: "review" };
  },
});
/** Simulate a second writer changing the same resistor after capture. This is a real undoable circuit edit. */
export const interruptMarkup = action({
  scope: appScope,
  name: "interrupt-markup",
  run() {
    const state = workflow.get();
    if (state.phase !== "review" || !state.proposal) throw new Error("Review a proposal first.");
    const next = state.proposal.after === 8200 ? 5600 : 8200;
    setResistance.run({
      key: state.proposal.target,
      ohms: next,
      expectedRevision: history.get().current.revision,
    });
    return { resistance: next, revision: history.get().current.revision };
  },
});
/** Explicitly review against the current circuit while retaining the original evidence and scripted requested value. */
export const reconsiderMarkup = action({
  scope: appScope,
  name: "reconsider-markup",
  run() {
    const state = workflow.get();
    if (state.phase !== "review" || !state.evidence)
      throw new Error("Review a captured request first.");
    const proposal = propose(state.evidence.view, history.get().current, true);
    flush(() => workflow.set({ ...state, proposal, message: undefined }));
    return proposal;
  },
});
/** Apply the revision-guarded proposal as one circuit undo step; retire only unchanged captured ink. */
export const applyMarkup = action({
  scope: appScope,
  name: "apply-markup",
  run() {
    const state = workflow.get();
    if (state.phase !== "review" || !state.evidence || !state.proposal)
      throw new Error("Review a captured request first.");
    if (proposalIsStale(state.proposal, history.get().current)) {
      flush(() =>
        workflow.set({
          ...state,
          message: "Nothing was applied. Review the current circuit before continuing.",
        }),
      );
      return { applied: false, reason: "stale" };
    }
    if (state.proposal.before === state.proposal.after) {
      flush(() =>
        workflow.set({
          ...state,
          message: "The current value already matches. Keep the current value to finish.",
        }),
      );
      return { applied: false, reason: "already-matches" };
    }
    const result = setResistance.run({
      key: state.proposal.target,
      ohms: state.proposal.after,
      expectedRevision: state.proposal.expectedRevision,
    }) as Circuit;
    const before = inkDocument.snapshot().strokes.length;
    inkDocument.retire(state.evidence.ink);
    flush(() =>
      workflow.set({
        ...state,
        phase: "applied",
        appliedRevision: result.revision,
        retired: before - inkDocument.snapshot().strokes.length,
        message: undefined,
      }),
    );
    return {
      applied: true,
      revision: result.revision,
      remainingStrokes: inkDocument.snapshot().strokes.length,
    };
  },
});
/** Undo this exercise's last circuit change. Refuse if another edit has since become the latest change. */
export const undoMarkup = action({
  scope: appScope,
  name: "undo-markup",
  run() {
    const state = workflow.get();
    if (state.phase !== "applied" || history.get().current.revision !== state.appliedRevision)
      throw new Error(
        "Another edit is now current. Use the circuit history to inspect it before undoing.",
      );
    undo.run();
    flush(() => workflow.set({ ...state, phase: "undone" }));
    return { revision: history.get().current.revision };
  },
});
/** Decline the proposed change; keep the circuit and all working ink. */
export const cancelMarkup = action({
  scope: appScope,
  name: "cancel-markup",
  run() {
    const state = workflow.get();
    if (state.phase !== "review") throw new Error("Review a proposal first.");
    flush(() => workflow.set({ ...state, phase: "cancelled", message: undefined }));
    return { phase: "cancelled" };
  },
});
/** Start another exercise. Clear this exercise's ink and evidence, preserving circuit values and history. */
export const restartMarkup = action({
  scope: appScope,
  name: "restart-markup",
  run() {
    for (const draft of inkDocument.snapshot().live) inkDocument.cancel(draft.id);
    inkDocument.clear();
    flush(() => workflow.set({ phase: "choose" }));
    return { phase: "choose" };
  },
});
/** Read the scripted workflow without serializing image data or raw pen samples. */
export const inspectMarkup = action({
  scope: appScope,
  name: "inspect-markup",
  kind: "read",
  run() {
    flush();
    const state = workflow.get();
    const evidence = state.evidence;
    const ink = inkDocument.snapshot();
    return {
      phase: state.phase,
      target: state.sheet?.target,
      sourceRevision: state.sheet?.circuit.revision,
      capturedStrokes: evidence?.ink.strokes.length ?? 0,
      workingStrokeIds: ink.strokes.map((stroke) => stroke.id),
      liveStrokes: ink.live.length,
      laterStrokes: evidence ? laterStrokes(evidence.ink, ink.strokes) : 0,
      attachedStrokes: evidence?.attachment.attached ?? 0,
      captureOnlyStrokes: evidence?.attachment.capturedOnly ?? 0,
      proposal: state.proposal,
      stale:
        state.phase === "review" &&
        !!state.proposal &&
        proposalIsStale(state.proposal, history.get().current),
      retired: state.retired,
      message: state.message,
    };
  },
});
