/**
 * mosaic.tsx — the Mosaic/vgplot bridge: the single seam between Solid and a
 * coordinator-connected Plot, graduated from the seismos notebook (the
 * porcelain-by-extraction path `PlotFigure` took — style-guide §porcelain).
 *
 * vgplot marks are imperative islands: Mosaic owns the SVG and its own
 * reactivity (Selections → coordinator → client queries → re-render). Solid
 * must not reach inside. So this bridge is the whole contract — a coordinator
 * and a spec (a list of vgplot directives) in, a DOM element out, clean
 * teardown on dispose — the same discipline as {@link ./plot}.PlotFigure, but
 * for a library that manages a *set* of coordinator-connected clients rather
 * than one self-contained figure.
 *
 * We build the Plot ourselves (rather than vgplot's `plot()` helper) for one
 * reason: to keep the marks, so disposal can `coordinator.disconnect` each and
 * not leak a client on every hot edit or theme flip. The spec is a reactive
 * thunk; reading a per-mode palette inside it makes a system theme change
 * rebuild the view against the surviving coordinator + selection.
 *
 * Lives on its own subpath (`@habemus-papadum/aiui-viz/mosaic`) so
 * `@uwdata/mosaic-plot` stays an optional peer only Mosaic consumers install.
 */
import { Plot } from "@uwdata/mosaic-plot";
import { createEffect } from "solid-js";

/** One vgplot directive (`vg.raster(...)`, `vg.width(...)`, …) applied to the Plot. */
export type Directive = (plot: Plot) => void;

/**
 * The slice of a Mosaic `Coordinator` this bridge drives — structural, so the
 * core barrel takes no dependency on `@uwdata/mosaic-core`; pass the real
 * coordinator your app holds as a durable root.
 */
export interface MosaicCoordinator {
  connect(client: unknown): void;
  disconnect(client: unknown): void;
}

/**
 * Mount one coordinator-connected vgplot view. The spec thunk is reactive:
 * any signal it reads (theme palette, layout size) rebuilds the Plot against
 * the surviving coordinator and selections; disposal disconnects every mark.
 */
export function MosaicView(props: {
  coordinator: MosaicCoordinator;
  spec: () => Directive[];
  class?: string;
}) {
  let host!: HTMLDivElement;
  createEffect(
    () => props.spec(),
    (directives) => {
      const p = new Plot(document.createElement("div"));
      for (const d of directives.flat()) d(p);
      for (const mark of p.marks) props.coordinator.connect(mark);
      // vgplot's own plot() calls update() argless for the initial full render;
      // the generated d.ts types the mark param as required, so pass undefined.
      p.update(undefined);
      host.replaceChildren(p.element);
      return () => {
        for (const mark of p.marks) props.coordinator.disconnect(mark);
        p.element.remove();
      };
    },
  );
  return <div class={props.class ? `mosaic-host ${props.class}` : "mosaic-host"} ref={host} />;
}
