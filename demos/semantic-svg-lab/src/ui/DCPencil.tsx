import { createMemo, onCleanup, Show } from "solid-js";
import { analyzeDC, editDC } from "../model/dc-circuit";
import { DC_SIZE } from "../model/dc-layout";
import {
  applyDCReturn,
  closeDCReturn,
  dcHistory,
  dcInk,
  dcPorts,
  dcScope,
  previewDCReturn,
  returnRequest,
} from "../model/dc-store";
import { DCScene, volts } from "./DCScene";
import { PencilCapturePad } from "./PencilCapturePad";
export function DCPencil(props: { attempt: (work: () => unknown) => void }) {
  const request = createMemo(() => {
    const value = returnRequest.get();
    if (!value) throw new Error("No return request.");
    return value;
  });
  const source = createMemo(() => request().source),
    before = createMemo(() => analyzeDC(source())),
    after = createMemo(() =>
      analyzeDC(editDC(source(), { kind: "connect", a: "R2/b", b: "V1/n" }, source().revision)),
    );
  const stale = () =>
    request().phase === "preview" && source().revision !== dcHistory.get().current.revision;
  let frame = 0;
  onCleanup(() => cancelAnimationFrame(frame));
  return (
    <section
      class="svg-dc-request"
      aria-label="Pencil return request"
      ref={(element) => {
        frame = requestAnimationFrame(() => element.scrollIntoView({ block: "start" }));
      }}
    >
      <div class="svg-lab-figure-heading">
        <span>Pencil request · reconnect the return</span>
        <span>{request().phase}</span>
      </div>
      <div class="svg-dc-request-grid">
        <div class="svg-dc-plate svg-dc-frozen">
          <svg viewBox="0 0 720 460" aria-label="Frozen circuit for the return request">
            <title>Original circuit and proposed return wire</title>
            <DCScene
              result={before()}
              layout={request().layout}
              names
              ghost={request().phase !== "mark" ? { a: "R2/b", b: "V1/n" } : undefined}
            />
          </svg>
          <Show
            when={request().phase === "mark"}
            fallback={
              <img
                class="svg-dc-evidence"
                src={request().image}
                alt="Captured return-wire markup"
              />
            }
          >
            <PencilCapturePad
              document={dcInk}
              scope={dcScope}
              size={DC_SIZE}
              ports={dcPorts}
              label="Sketch the return wire"
              color="#f2c66d"
            />
          </Show>
        </div>
        <div>
          <Show
            when={request().phase === "mark"}
            fallback={
              <>
                <h3>
                  {request().phase === "applied" ? "Return connected" : "Connect R2/b to V1/n"}
                </h3>
                <p>
                  The dashed wire is the proposed connection. Compare its consequence before
                  applying.
                </p>
                <dl class="svg-dc-comparison">
                  <dt>OUT before</dt>
                  <dd>{volts(before().output)}</dd>
                  <dt>OUT after</dt>
                  <dd>{volts(after().output)}</dd>
                  <dt>Design target</dt>
                  <dd>{after().goalMet ? "6 V with the load connected" : "Not yet met"}</dd>
                </dl>
                <Show when={after().status === "short"}>
                  <p>
                    This connection would short the supply. Cancel and inspect the existing wires.
                  </p>
                </Show>
                <Show when={stale()}>
                  <p role="status">
                    The circuit changed. Start a new request before applying. The original evidence
                    stays here.
                  </p>
                </Show>
                <Show when={request().phase === "preview"}>
                  <button
                    type="button"
                    class="btn btn-outline"
                    disabled={stale()}
                    onClick={() => props.attempt(() => applyDCReturn.run())}
                  >
                    Apply connection
                  </button>
                </Show>
                <Show when={request().phase === "applied"}>
                  <p>
                    The live views above reflect the edit. Undo circuit edit removes the new wire.
                  </p>
                </Show>
              </>
            }
          >
            <h3>Draw the missing return</h3>
            <p>Mark a connection from R2/b to V1/n on this frozen drawing.</p>
            <p class="svg-lab-caption">
              Scripted interpretation: these two terminals are chosen in advance. The Pencil toolkit
              captures your actual marks.
            </p>
            <button
              type="button"
              class="btn btn-outline"
              onClick={() => props.attempt(() => previewDCReturn.run())}
            >
              Preview connection
            </button>
          </Show>
          <button type="button" class="btn btn-outline" onClick={() => closeDCReturn.run()}>
            {request().phase === "applied" ? "Close request" : "Cancel request"}
          </button>
        </div>
      </div>
    </section>
  );
}
