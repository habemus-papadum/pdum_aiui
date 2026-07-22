/**
 * FitOverlay.tsx — the abstract numbers, drawn back onto the paper. Over the
 * ink sits the best-fit circle (dashed blue), the moment ellipse (green,
 * tilted), and the fitted centre — so you SEE how far your stroke strayed from
 * a true circle, not just read it. Purely a reader of the `stats` cell; no
 * pointer events (it never intercepts the pencil).
 *
 * Mode-aware (the anti-cheat): the full fit shows LIVE only in `guide` mode.
 * In `zen`/`blind` it is hidden while drawing (the Zen centre-ghost handles the
 * live guide) and appears only once the stroke has SETTLED — the reveal.
 *
 * It reads the cell's `latest()` directly (not through CellView) because it
 * renders positioned geometry, not a card — so it carries the `data-cell="stats"`
 * attribution stamp itself, the one hand-written attribution attribute allowed.
 */

import type { JSX } from "@solidjs/web";
import { Show } from "@solidjs/web";
import { graph } from "../model/graph";
import { guideMode, turnPhase } from "../model/store";

export function FitOverlay(): JSX.Element {
  const stats = () => graph().stats.latest() ?? null;
  // Reveal the fit live only in guide mode; otherwise wait for the lift.
  const shown = () =>
    guideMode.get() === "guide" || turnPhase.get() === "settled" ? stats() : null;
  return (
    <div class="fit-overlay" data-cell="stats">
      <Show when={shown()}>
        {(s) => (
          <>
            <div
              class="fit-ring"
              style={{
                left: `${s().center.x}px`,
                top: `${s().center.y}px`,
                width: `${s().radius * 2}px`,
                height: `${s().radius * 2}px`,
              }}
            />
            <div
              class="fit-ellipse"
              style={{
                left: `${s().center.x - s().major}px`,
                top: `${s().center.y - s().minor}px`,
                width: `${s().major * 2}px`,
                height: `${s().minor * 2}px`,
                transform: `rotate(${s().tiltDeg}deg)`,
                "transform-origin": "center",
              }}
            />
            <div
              class="fit-center"
              style={{ left: `${s().center.x}px`, top: `${s().center.y}px` }}
            />
          </>
        )}
      </Show>
    </div>
  );
}
