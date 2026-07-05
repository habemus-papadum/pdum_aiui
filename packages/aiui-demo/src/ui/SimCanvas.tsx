/**
 * SimCanvas.tsx — the component that *adopts* the durable canvas.
 *
 * The canvas (and its WebGL context, and the pattern accrued in its textures)
 * is created once in store.ts and survives every hot edit; this component
 * merely parents it into the current DOM and wires pointer painting. Swap
 * this file all day — the morphogenesis keeps cooking.
 *
 */
import { onCleanup } from "solid-js";
import { brushRadius, sim, simCanvas, speed } from "../model/store";

export function SimCanvas() {
  const uv = (e: PointerEvent): { x: number; y: number } => {
    const rect = simCanvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / rect.width,
      y: 1 - (e.clientY - rect.top) / rect.height, // texture v runs up
    };
  };

  let painting = false;
  const paint = (e: PointerEvent) => {
    const { x, y } = uv(e);
    sim.engine.setBrush({ x, y, radius: brushRadius.get() });
    // While paused, run a single step so the splat still lands.
    if (speed.get() === 0) sim.engine.step(1);
  };
  const down = (e: PointerEvent) => {
    painting = true;
    simCanvas.setPointerCapture(e.pointerId);
    paint(e);
  };
  const move = (e: PointerEvent) => {
    if (painting) paint(e);
  };
  const up = () => {
    painting = false;
    sim.engine.setBrush(null);
  };

  // Solid 2.0 dropped onMount; the ref callback runs when the element exists,
  // which is exactly when the durable canvas can be adopted.
  let myHost: HTMLDivElement | undefined;
  const adopt = (host: HTMLDivElement) => {
    myHost = host;
    host.appendChild(simCanvas);
    simCanvas.addEventListener("pointerdown", down);
    simCanvas.addEventListener("pointermove", move);
    simCanvas.addEventListener("pointerup", up);
    simCanvas.addEventListener("pointercancel", up);
  };
  onCleanup(() => {
    simCanvas.removeEventListener("pointerdown", down);
    simCanvas.removeEventListener("pointermove", move);
    simCanvas.removeEventListener("pointerup", up);
    simCanvas.removeEventListener("pointercancel", up);
    // HMR ordering hazard: the replacement component may have ALREADY adopted
    // the canvas into its own host by the time this cleanup runs. Un-parent
    // only if the canvas is still ours — never take it from the successor.
    if (simCanvas.parentElement === myHost) simCanvas.remove();
  });

  return <div class="sim-host" ref={adopt} title="drag to paint chemical V into the field" />;
}
