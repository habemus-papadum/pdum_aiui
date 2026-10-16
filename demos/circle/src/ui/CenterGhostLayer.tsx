/** Adopt the centre guide and activate it only while drawing in Zen mode. */

import { adopt } from "@habemus-papadum/aiui-viz";
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
  return (
    <div
      class="ghost-layer"
      ref={adopt((host) => {
        host.append(centerGhost.canvas);
        return () => {
          if (centerGhost.canvas.parentElement !== host) return;
          centerGhost.disarm();
          centerGhost.canvas.remove();
        };
      })}
    />
  );
}
