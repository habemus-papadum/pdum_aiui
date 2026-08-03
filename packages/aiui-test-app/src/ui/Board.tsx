/**
 * Board.tsx — the instrument: a dark plate where the mixture is drawn,
 * sampled, and fitted, all in one coordinate space (the 680×460 board).
 *
 * Four layers, back to front:
 *   1. the hexbin histogram of the current sample   (CellView of `hexes`)
 *   2. the drawn components, as blue ellipses       (the `ellipses` durable)
 *   3. the EM estimate, as dashed pink ellipses     (CellView of `fit` —
 *      re-rendered per streamed iteration, so the fit visibly walks on)
 *   4. the pencil canvas (adopted durable DOM)      — the user draws HERE
 *
 * The plate is a self-contained dark figure in both color modes (the sim-
 * canvas convention): ink and overlay colors are cross-mode constants.
 */
import { CellView } from "@habemus-papadum/aiui-viz";
import { For, Show } from "solid-js";
import { EM_ITERATIONS, graph, HEX_RADIUS } from "../model/graph";
import { type EllipseShape, ellipseFromGaussian, hexPoints } from "../model/mixture2d";
import { BOARD_H, BOARD_W, ellipses, paper } from "../model/store";

const HEX_OUTLINE = hexPoints(HEX_RADIUS);

function EllipseMark(props: { e: EllipseShape; cls: string }) {
  return (
    <ellipse
      class={props.cls}
      cx={props.e.cx}
      cy={props.e.cy}
      rx={props.e.a}
      ry={props.e.b}
      transform={`rotate(${(props.e.angle * 180) / Math.PI} ${props.e.cx} ${props.e.cy})`}
    />
  );
}

export function Board() {
  const adoptStage = (el: HTMLDivElement): void => {
    el.append(paper.canvas);
    paper.setActive(true);
  };

  return (
    <section class="panel chart">
      <h2>mixture board</h2>
      <div class="board">
        {/* 1. the data: hex-binned sample density */}
        <div class="board-layer">
          <CellView of={graph().hexes} label="binning">
            {(h) => (
              <svg class="board-svg" viewBox={`0 0 ${BOARD_W} ${BOARD_H}`} role="img">
                <title>hex-binned sample density</title>
                <For each={h().bins}>
                  {(b) => (
                    <polygon
                      class="hex"
                      points={HEX_OUTLINE}
                      transform={`translate(${b.cx} ${b.cy})`}
                      fill-opacity={0.08 + 0.9 * Math.sqrt(b.count / (h().maxCount || 1))}
                    />
                  )}
                </For>
              </svg>
            )}
          </CellView>
        </div>

        {/* 2. the truth: what the user drew */}
        <svg class="board-svg board-layer" viewBox={`0 0 ${BOARD_W} ${BOARD_H}`} role="img">
          <title>drawn components</title>
          <For each={ellipses.get()}>{(e) => <EllipseMark e={e} cls="ellipse-truth" />}</For>
        </svg>

        {/* 3. the estimate: EM's belief, streaming in */}
        <Show when={ellipses.get().length > 0}>
          <div class="board-layer">
            <CellView of={graph().fit} label={`fitting (${EM_ITERATIONS} iterations)`}>
              {(step) => (
                <svg class="board-svg" viewBox={`0 0 ${BOARD_W} ${BOARD_H}`} role="img">
                  <title>EM estimate</title>
                  <For each={step().params.components}>
                    {(g) => (
                      <>
                        <EllipseMark e={ellipseFromGaussian(g)} cls="ellipse-fit" />
                        <circle class="fit-mean" cx={g.mx} cy={g.my} r={2.5} />
                      </>
                    )}
                  </For>
                </svg>
              )}
            </CellView>
          </div>
        </Show>

        {/* 4. the pen — owns the pointer */}
        <div class="board-stage" ref={adoptStage} />

        <Show when={ellipses.get().length === 0}>
          <p class="board-hint">
            draw a component as an ellipse — its centre is the mean, its shape and tilt the
            covariance (read as the 2σ contour)
          </p>
        </Show>
      </div>
      <p class="legend muted">
        <span class="swatch swatch-hex" /> sample density &nbsp;
        <span class="swatch swatch-truth" /> drawn component &nbsp;
        <span class="swatch swatch-fit" /> EM estimate &nbsp;
      </p>
    </section>
  );
}
