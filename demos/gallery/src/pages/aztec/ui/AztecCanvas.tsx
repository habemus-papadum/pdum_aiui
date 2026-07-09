/**
 * AztecCanvas.tsx — the component that *adopts* the durable canvas.
 *
 * The canvas (and the tiling painted on it) is created once in store.ts and
 * survives every hot edit; this component only parents it into the current DOM.
 * Copies morphogen's SimCanvas discipline, cleanup guard included: the
 * replacement render may adopt the canvas before this one's cleanup runs, so we
 * un-parent only if it is still ours — never take it from a successor.
 */
import { onCleanup } from "solid-js";
import { aztecCanvas } from "../store";

export function AztecCanvas() {
  let myHost: HTMLDivElement | undefined;
  const adopt = (host: HTMLDivElement) => {
    myHost = host;
    host.appendChild(aztecCanvas);
  };
  onCleanup(() => {
    if (aztecCanvas.parentElement === myHost) aztecCanvas.remove();
  });
  return <div class="aztec-host" ref={adopt} title="a uniformly-random domino tiling of AD(n)" />;
}
