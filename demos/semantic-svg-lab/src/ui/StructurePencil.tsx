import { createMemo, onCleanup, Show } from "solid-js";
import { analyzeStructure, editStructure } from "../model/structure";
import {
  applyBrace,
  braceRequest,
  closeBrace,
  previewBrace,
  structureHistory,
  structureInk,
  structurePorts,
  structureScope,
} from "../model/structure-store";
import { PencilCapturePad } from "./PencilCapturePad";
import { STRUCTURE_SIZE, StructureScene, structureView } from "./StructureScene";

export function StructurePencil(props: { attempt: (work: () => unknown) => void }) {
  const request = createMemo(() => {
    const current = braceRequest.get();
    if (!current) throw new Error("No pencil request.");
    return current;
  });
  const source = createMemo(() => request().source);
  const before = createMemo(() => analyzeStructure(source()));
  const after = createMemo(() =>
    analyzeStructure(
      editStructure(
        request().source,
        { kind: "add", ...request().brace },
        request().source.revision,
      ),
    ),
  );
  const stale = () =>
    request().phase === "preview" &&
    request().source.revision !== structureHistory.get().current.revision;
  let scrollFrame = 0;
  onCleanup(() => cancelAnimationFrame(scrollFrame));
  return (
    <section
      class="svg-structure-request"
      aria-label="Pencil brace proposal"
      ref={(element) => {
        scrollFrame = requestAnimationFrame(() => element.scrollIntoView({ block: "start" }));
      }}
    >
      <div class="svg-lab-figure-heading">
        <span>
          Pencil request · {request().brace.a}
          {request().brace.b}
        </span>
        <span>
          {request().phase === "mark"
            ? "mark"
            : request().phase === "preview"
              ? "review"
              : "applied"}
        </span>
      </div>
      <div class="svg-structure-request-grid">
        <div class="svg-structure-plate svg-structure-frozen">
          <svg viewBox="0 0 640 420" aria-label="Original structure for this pencil request">
            <title>Frozen structure with a scripted brace proposal</title>
            <StructureScene
              result={before()}
              view={structureView(request().source)}
              ghost={request().phase !== "mark" ? request().brace : undefined}
            />
          </svg>
          <Show
            when={request().phase === "mark"}
            fallback={
              <img
                class="svg-structure-evidence"
                src={request().image}
                alt="Captured pencil marks"
              />
            }
          >
            <PencilCapturePad
              document={structureInk}
              scope={structureScope}
              size={STRUCTURE_SIZE}
              ports={structurePorts}
              label="Sketch the proposed brace"
              color="#f2c66d"
              class="svg-structure-ink"
            />
          </Show>
        </div>
        <div>
          <Show when={request().phase === "mark"}>
            <h3>
              Sketch a brace from {request().brace.a} to {request().brace.b}
            </h3>
            <p>
              Draw on this frozen view with a pencil, mouse or finger. The next step will propose
              that connection.
            </p>
            <p class="svg-lab-caption">
              Scripted interpretation: the endpoints are chosen in advance. Your ink is kept as the
              request.
            </p>
            <button
              class="btn btn-outline"
              type="button"
              onClick={() => props.attempt(() => previewBrace.run())}
            >
              Preview brace
            </button>
          </Show>
          <Show when={request().phase !== "mark"}>
            <h3>
              {request().phase === "applied"
                ? "Brace added"
                : `Add member ${request().brace.a}${request().brace.b}`}
            </h3>
            <p>
              The dashed member is the proposed change. The original drawing and captured ink stay
              here for comparison.
            </p>
            <dl class="svg-structure-comparison">
              <dt>Before</dt>
              <dd>{statusLabel(before().status)}</dd>
              <dt>With brace</dt>
              <dd>{statusLabel(after().status)}</dd>
            </dl>
            <Show when={after().status !== "solved"}>
              <p>{after().diagnostics[0]?.detail}</p>
            </Show>
            <Show when={stale()}>
              <p role="status">The live structure changed. Start a new request before applying.</p>
            </Show>
            <Show when={request().phase === "preview"}>
              <button
                class="btn btn-outline"
                type="button"
                disabled={stale()}
                onClick={() => props.attempt(() => applyBrace.run())}
              >
                Apply brace
              </button>
            </Show>
            <Show when={request().phase === "applied"}>
              <p>Compare the live views above. Undo removes the new member.</p>
            </Show>
          </Show>
          <button class="btn btn-outline" type="button" onClick={() => closeBrace.run()}>
            {request().phase === "applied" ? "Close request" : "Cancel request"}
          </button>
        </div>
      </div>
    </section>
  );
}
export function statusLabel(status: string) {
  return (
    (
      {
        solved: "Unique equilibrium",
        mechanism: "Unconstrained motion",
        indeterminate: "Forces not unique",
        invalid: "Geometry unresolved",
        numerical: "Numerical result unresolved",
      } as Record<string, string>
    )[status] ?? status
  );
}
