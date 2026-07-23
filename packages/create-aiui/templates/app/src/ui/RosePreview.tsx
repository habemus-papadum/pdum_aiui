// <aiui-scenery-file> — this WHOLE FILE is placeholder scenery: delete it on reset (CLAUDE.md § Reset).
/**
 * RosePreview.tsx — the starter's landing-card preview (see card.tsx): a slowly
 * morphing Maurer rose, drawn straight from the pure math in model/rose.ts —
 * no store, no graph, no cell. That self-containment is the point of a card
 * preview: a gallery mounts every app's preview at once, so it must be cheap
 * and must not touch this app's heavy durable graph.
 */
import { onCleanup } from "solid-js";
import { buildRose } from "../model/rose";

export function RosePreview() {
  let walk: SVGPathElement | undefined;
  let outline: SVGPathElement | undefined;
  let raf = 0;
  let t = 0;
  let lastPetals = -1;
  let lastStep = -1;
  const loop = (): void => {
    raf = requestAnimationFrame(loop);
    t += 0.004;
    const petals = 4 + Math.round(2.5 + 2.5 * Math.sin(t));
    const step = 71 + Math.round(24 * Math.sin(t * 0.6));
    if (petals === lastPetals && step === lastStep) return;
    lastPetals = petals;
    lastStep = step;
    const rose = buildRose({ petals, step });
    walk?.setAttribute("d", rose.walk);
    outline?.setAttribute("d", rose.outline);
  };
  raf = requestAnimationFrame(loop);
  onCleanup(() => cancelAnimationFrame(raf));

  return (
    <svg
      viewBox="-1.15 -1.15 2.3 2.3"
      role="img"
      aria-label="A morphing Maurer rose"
      style={{ width: "100%", height: "100%", display: "block", background: "#0e1119" }}
    >
      <title>A morphing Maurer rose</title>
      <path ref={outline} fill="none" stroke="#4a5578" stroke-width="0.007" />
      <path ref={walk} fill="none" stroke="#8ab4f8" stroke-width="0.004" />
    </svg>
  );
}
