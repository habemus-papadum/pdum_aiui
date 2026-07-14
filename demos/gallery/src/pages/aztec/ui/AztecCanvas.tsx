/**
 * AztecCanvas.tsx — the component that *adopts* the durable canvas.
 *
 * The canvas (and the tiling painted on it) is created once in store.ts and
 * survives every hot edit; this component only parents it into the current DOM.
 * The adoption — including the rule that a cleanup must never take the canvas
 * back from a successor that already adopted it — belongs to `durableCanvas`,
 * which is where this component's hand-rolled version of it went.
 */
import { aztecSurface } from "../store";

export function AztecCanvas() {
  return (
    <div
      class="aztec-host"
      ref={aztecSurface.adopt()}
      title="a uniformly-random domino tiling of AD(n)"
    />
  );
}
