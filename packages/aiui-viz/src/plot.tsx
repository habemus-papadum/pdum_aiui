/**
 * PlotFigure.tsx — the Observable Plot bridge: reactive options in, a
 * rendered figure out. Plot builds a complete SVG per call, so the effect
 * simply rebuilds on change — cheap at these data sizes, and the pattern
 * keeps a third-party imperative library at arm's length behind one seam
 * (the same boundary discipline as the WebGL engine, in miniature).
 *
 * The figure's width follows its host (the resize seam, `elementWidth`)
 * unless the author's options set `width` themselves; the host element is
 * created in the component body, not by a ref, because an effect's compute
 * runs before refs bind and the width must be read in the compute.
 */

import * as Plot from "@observablehq/plot";
import { createEffect } from "solid-js";
import { elementWidth } from "./viewport";

export function PlotFigure(props: { options: () => Plot.PlotOptions }) {
  const host = document.createElement("div");
  host.className = "plot-host";
  const hostWidth = elementWidth(host);
  createEffect(
    (): Plot.PlotOptions => {
      const options = props.options();
      if (options.width !== undefined) return options;
      // An unmeasured host (not laid out yet, display: none) leaves Plot's default.
      const width = hostWidth();
      return width > 0 ? { ...options, width } : options;
    },
    (options) => {
      const figure = Plot.plot(options);
      host.replaceChildren(figure);
      return () => figure.remove();
    },
  );
  return host;
}
