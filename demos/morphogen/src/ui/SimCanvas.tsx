/**
 * SimCanvas.tsx — the component that *adopts* the durable canvas.
 *
 * The canvas (and its WebGL context, and the pattern accrued in its textures)
 * is created once in store.ts and survives every hot edit; this component
 * merely parents it into the current DOM and wires pointer painting. Swap
 * this file all day — the morphogenesis keeps cooking.
 *
 */
import { brushRadius, sim, simCanvas, simSurface, speed } from "../model/store";

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

  // `simSurface.adopt` parents the durable canvas, registers this component's
  // listeners, and — the part every hand-rolled copy of this had to re-derive —
  // releases them without taking the canvas back from a hot-swapped successor.
  const paint_events = (canvas: HTMLCanvasElement) => {
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
    return () => {
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
    };
  };

  return (
    <div
      class="sim-host"
      ref={simSurface.adopt(paint_events)}
      title="drag to paint chemical V into the field"
    />
  );
}
