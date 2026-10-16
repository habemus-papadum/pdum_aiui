/** A small application-owned capture, result, and retirement workflow. */
import { type JSX, Show } from "@solidjs/web";
import { applySampleResult, captureInk } from "../model/graph";
import { captureReview } from "../model/store";

export function CaptureReview(): JSX.Element {
  return (
    <section class="panel capture-review" id="capture-review">
      <h2>Capture and replace</h2>
      <p class="hint">
        Capture completed ink, keep drawing, then apply a sample symbolic result. This fixture
        demonstrates replacement and review; it does not recognize your drawing.
      </p>
      <div class="row">
        <button type="button" class="btn" onClick={() => captureInk.run?.()}>
          Capture ink
        </button>
        <button
          type="button"
          class="btn"
          disabled={!captureReview.get() || captureReview.get()?.applied}
          onClick={() => applySampleResult.run?.()}
        >
          Apply sample result
        </button>
      </div>
      <Show when={captureReview.get()}>
        {(review) => (
          <>
            <p class="hint" data-capture-status>
              Captured {review().capture.strokes.length} strokes at revision{" "}
              {review().capture.revision}.
              {review().applied
                ? ` Applied; retired ${review().retired} unchanged captured strokes.`
                : " Waiting to apply."}
            </p>
            <div class="capture-comparison">
              <figure>
                <figcaption>Original input</figcaption>
                <img src={review().image} alt="Ink preserved at capture time" />
              </figure>
              <figure>
                <figcaption>Sample symbolic result</figcaption>
                <div class="symbolic-result" data-symbolic-result>
                  {review().applied ? "x² + y² = r²" : "Pending"}
                </div>
              </figure>
            </div>
            <p class="hint">
              The capture stays unchanged. New strokes and revisions remain on the pad.
            </p>
          </>
        )}
      </Show>
    </section>
  );
}
