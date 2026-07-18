/**
 * PlotFigure.tsx — the Observable Plot bridge: reactive options in, a
 * rendered figure out. Plot builds a complete SVG per call, so the effect
 * simply rebuilds on change — cheap at these data sizes, and the pattern
 * keeps a third-party imperative library at arm's length behind one seam
 * (the same boundary discipline as the WebGL engine, in miniature).
 */

import * as Plot from "@observablehq/plot";
import { createEffect } from "solid-js";

export function PlotFigure(props: { options: () => Plot.PlotOptions }) {
  let host!: HTMLDivElement;
  createEffect(
    () => props.options(),
    (options) => {
      const figure = Plot.plot(options);
      host.replaceChildren(figure);
      return () => figure.remove();
    },
  );
  return <div class="plot-host" ref={host} />;
}
