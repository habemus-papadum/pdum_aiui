/**
 * CenterGhostLayer.tsx — mounts the durable {@link centerGhost} canvas into the
 * stage and arms it only when it should draw: `zen` mode, mid-stroke. The rAF
 * loop lives in the renderer (imperative island); this component is just the
 * reactive bridge — a two-arg `createEffect` that pushes (mode, phase) changes
 * into `arm()`/`disarm()`, never reading signals inside the animation loop.
 */

import type { JSX } from "@solidjs/web";
import { createEffect } from "solid-js";
import { centerGhost, guideMode, turnPhase } from "../model/store";

export function CenterGhostLayer(): JSX.Element {
  createEffect(
    () => ({ mode: guideMode.get(), phase: turnPhase.get() }),
    ({ mode, phase }) => {
      if (mode === "zen" && phase === "drawing") {
        centerGhost.arm();
      } else {
        centerGhost.disarm();
      }
    },
  );
  return <div class="ghost-layer" ref={(el) => el.append(centerGhost.canvas)} />;
}
