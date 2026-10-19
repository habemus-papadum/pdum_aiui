import {
  CellView,
  ControlSlider,
  ControlToggle,
  type RegisteredAction,
} from "@habemus-papadum/aiui-viz";
import { createSignal, For, Show } from "solid-js";
import { resistanceLabel, resolveFeature } from "../model/circuit";
import { graph } from "../model/graph";
import { type Evidence, proposalIsStale, scriptedValue } from "../model/markup";
import {
  applyMarkup,
  beginMarkup,
  cancelMarkup,
  captureMarkup,
  inkDocument,
  interruptMarkup,
  markupPorts,
  reconsiderMarkup,
  restartMarkup,
  reviewMarkup,
  undoMarkup,
  workflow,
} from "../model/markup-store";
import { history, lensVisible, magnification, selected, zoom } from "../model/store";
import { CircuitBoard } from "./CircuitBoard";
import { MarkupPad } from "./MarkupPad";

const steps = ["Choose", "Mark", "Capture", "Review", "Apply"];
function EvidenceCard(props: { evidence: Evidence }) {
  return (
    <figure class="svg-lab-evidence">
      <div class="svg-lab-figure-heading">
        <span>Captured request</span>
        <span>revision {props.evidence.view.circuit.revision}</span>
      </div>
      <div class="svg-lab-evidence-image" data-evidence-revision={props.evidence.ink.revision}>
        <img src={props.evidence.view.image} alt="Original circuit view at capture" />
        <img
          class="svg-lab-evidence-ink"
          src={props.evidence.inkImage}
          alt="Immutable captured handwriting"
        />
      </div>
      <figcaption>
        {props.evidence.view.target.startsWith("a/") ? "A" : "B"} · R1 ·{" "}
        {props.evidence.ink.strokes.length} captured{" "}
        {props.evidence.ink.strokes.length === 1 ? "stroke" : "strokes"}. This evidence stays
        unchanged.
      </figcaption>
      <Show when={props.evidence.attachment.capturedOnly > 0}>
        <p class="svg-lab-caption">
          {props.evidence.attachment.capturedOnly}{" "}
          {props.evidence.attachment.capturedOnly === 1 ? "stroke crosses" : "strokes cross"} a lens
          boundary or header. Kept here without projecting{" "}
          {props.evidence.attachment.capturedOnly === 1 ? "it" : "them"} onto the live circuit.
        </p>
      </Show>
    </figure>
  );
}

export function GuidedMarkup() {
  const [error, setError] = createSignal("");
  const state = () => workflow.get();
  const stats = () => graph().markup.latest() ?? { completed: 0, live: 0, later: 0 };
  const step = () =>
    ({ choose: 0, mark: 1, continue: 2, review: 3, applied: 4, undone: 4, cancelled: 4 })[
      state().phase
    ];
  const chosen = () => resolveFeature(selected.get());
  const targetName = () =>
    `${(state().sheet?.target ?? selected.get()).startsWith("a/") ? "A" : "B"} · R1`;
  const desired = () => {
    const current = state();
    if (current.proposal) return current.proposal.after;
    if (!current.sheet) return 6800;
    return scriptedValue(
      current.sheet.circuit.stages[resolveFeature(current.sheet.target).ref.occurrence].resistance,
    );
  };
  const proposal = () => {
    const value = state().proposal;
    if (!value) throw new Error("Review requires a proposal.");
    return value;
  };
  const stale = () => {
    const current = state();
    return (
      current.phase === "review" &&
      !!current.proposal &&
      proposalIsStale(current.proposal, history.get().current)
    );
  };
  const finished = () => ["applied", "undone", "cancelled"].includes(state().phase);
  const liveBoard = () => state().phase === "choose" || state().phase === "review" || finished();
  const run = (action: RegisteredAction) => {
    try {
      action.run();
      setError("");
    } catch (cause) {
      setError((cause as Error).message);
    }
  };
  return (
    <section class="svg-lab-guided" aria-label="Guided markup workflow">
      <ol class="svg-lab-stepper">
        {" "}
        <For each={steps}>
          {(label, index) => (
            <li
              aria-current={step() === index() ? "step" : undefined}
              data-complete={step() > index() ? "true" : undefined}
            >
              <span>{index() + 1}</span>
              {label}
            </li>
          )}
        </For>
      </ol>
      <div class="svg-lab-guide" data-workflow-phase={state().phase}>
        <div>
          <p class="svg-lab-eyebrow">Step {step() + 1} of 5 · scripted exercise</p>
          <Show when={state().phase === "choose"}>
            <h2>Choose a resistor to change</h2>
            <p>
              Select R1’s value in A or B. Move the lens or turn it off to choose the view you want
              to mark.
            </p>
            <p class="svg-lab-caption">
              Your selection supplies the target. The response is scripted; AI interpretation will
              have its own lab.
            </p>
          </Show>
          <Show when={state().phase === "mark"}>
            <h2>
              Circle {targetName()} and write “{resistanceLabel(desired())}”
            </h2>
            <p>
              Use a pen, mouse or finger. The view is held still while you mark it. Capture when
              your note is ready.
            </p>
          </Show>
          <Show when={state().phase === "continue"}>
            <h2>Add one more mark</h2>
            <p>
              Put a dot or a short line somewhere else on the working sheet. Compare it with the
              captured request: your new mark belongs only to the working sheet.
            </p>
          </Show>
          <Show when={state().phase === "review"}>
            <h2>
              {stale()
                ? "The circuit changed after capture"
                : `Review the change to ${targetName()}`}
            </h2>
            <Show
              when={!stale()}
              fallback={
                <p>
                  The original request is preserved. Review the current value before applying its
                  proposed change.
                </p>
              }
            >
              <p class="svg-lab-change">
                {resistanceLabel(proposal().before)} <span class="svg-lab-change-arrow">→</span>{" "}
                {resistanceLabel(proposal().after)}
              </p>
              <p>
                The arrow on the live circuit previews the scripted result. Pan, zoom or move the
                lens to see eligible marks follow the selected resistor.
              </p>
              <Show when={state().proposal?.reviewed}>
                <p class="svg-lab-caption">
                  Reviewed against revision {state().proposal?.expectedRevision}; original evidence
                  remains at revision {state().proposal?.evidenceRevision}.
                </p>
              </Show>
            </Show>
            <Show when={stale()}>
              <p class="svg-lab-change">
                Current:{" "}
                {resistanceLabel(
                  history.get().current.stages[resolveFeature(proposal().target).ref.occurrence]
                    .resistance,
                )}{" "}
                · proposed: {resistanceLabel(desired())}
              </p>
            </Show>
          </Show>
          <Show when={finished()}>
            <h2>
              {state().phase === "applied"
                ? "Applied. Your newer ink is still here."
                : state().phase === "undone"
                  ? "Circuit change undone. Evidence preserved."
                  : "Current value kept. Your ink is preserved."}
            </h2>
            <p>
              {state().phase === "cancelled"
                ? "The proposal was declined without changing the circuit or retiring any marks."
                : `Your submitted marks are saved with the request. ${stats().completed} ${stats().completed === 1 ? "mark remains" : "marks remain"} on the working sheet below.`}
            </p>
          </Show>
          <Show when={error() || state().message}>
            <p role="alert" class="svg-lab-flow-error">
              {error() || state().message}
            </p>
          </Show>
        </div>
        <div class="svg-lab-guide-actions">
          <Show when={state().phase === "choose"}>
            <button
              class="btn"
              type="button"
              disabled={chosen().ref.part !== "R1" || chosen().ref.feature !== "value"}
              onClick={() => run(beginMarkup)}
            >
              Begin marking
            </button>
          </Show>
          <Show when={state().phase === "mark"}>
            <button
              class="btn"
              type="button"
              disabled={!stats().completed || !!stats().live}
              onClick={() => run(captureMarkup)}
            >
              Capture request
            </button>
          </Show>
          <Show when={state().phase === "continue"}>
            <button
              class="btn"
              type="button"
              disabled={!stats().later || !!stats().live}
              onClick={() => run(reviewMarkup)}
            >
              Review scripted change
            </button>
          </Show>
          <Show when={state().phase === "mark" || state().phase === "continue"}>
            <span class="svg-lab-caption" role="status">
              {stats().completed} strokes
              {state().phase === "continue" ? ` · ${stats().later} added after capture` : ""}
            </span>
            <button
              class="btn btn-outline"
              type="button"
              disabled={!stats().completed || !!stats().live}
              onClick={() => {
                inkDocument.undo();
                setError("");
              }}
            >
              Undo last mark
            </button>
          </Show>
          <Show when={state().phase === "review"}>
            <Show
              when={stale()}
              fallback={
                <button class="btn" type="button" onClick={() => run(applyMarkup)}>
                  Apply proposed change
                </button>
              }
            >
              <button class="btn" type="button" onClick={() => run(reconsiderMarkup)}>
                Review current circuit
              </button>
              <button class="btn btn-outline" type="button" onClick={() => run(applyMarkup)}>
                Try original proposal
              </button>
            </Show>
            <Show when={!stale()}>
              <button class="btn btn-outline" type="button" onClick={() => run(interruptMarkup)}>
                Try an intervening edit
              </button>
            </Show>
            <button class="btn btn-outline" type="button" onClick={() => run(cancelMarkup)}>
              Keep current value
            </button>
          </Show>
          <Show when={state().phase === "applied"}>
            <button
              class="btn"
              type="button"
              disabled={history.get().current.revision !== state().appliedRevision}
              onClick={() => run(undoMarkup)}
            >
              Undo circuit change
            </button>
          </Show>
          <Show when={state().phase !== "choose"}>
            <button class="btn btn-outline" type="button" onClick={() => run(restartMarkup)}>
              {finished() ? "Start another exercise" : "Restart exercise"}
            </button>
          </Show>
        </div>
      </div>
      <Show when={liveBoard()}>
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
        </div>
        <CellView of={graph().circuit}>
          {(circuit) => (
            <CircuitBoard
              circuit={circuit()}
              hideEditor
              evidence={state().evidence}
              proposal={state().phase === "review" ? state().proposal : undefined}
              registerSnapshot={(read) => {
                markupPorts.readView = read;
                return () => {
                  if (markupPorts.readView === read) delete markupPorts.readView;
                };
              }}
            />
          )}
        </CellView>
      </Show>
      <Show when={state().sheet} keyed>
        {(sheet) => (
          <div
            class={`svg-lab-sheets${finished() || state().phase === "review" ? " is-review" : ""}`}
          >
            <div class="svg-lab-working-sheet" hidden={state().phase === "review"}>
              <div class="svg-lab-figure-heading">
                <span>{finished() ? "Remaining working ink" : "Working sheet"}</span>
                <span>{stats().completed} strokes</span>
              </div>
              <MarkupPad
                sheet={sheet}
                active={state().phase === "mark" || state().phase === "continue"}
              />
              <p class="svg-lab-caption">
                This sheet keeps the view you marked. Its ink remains editable during the drawing
                steps.
              </p>
            </div>
            <Show when={state().evidence}>
              {(evidence) => <EvidenceCard evidence={evidence()} />}
            </Show>
          </div>
        )}
      </Show>
    </section>
  );
}
