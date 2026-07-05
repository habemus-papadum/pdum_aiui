/**
 * MosaicView.tsx — the single seam between Solid and Mosaic/vgplot.
 *
 * vgplot marks are imperative islands: Mosaic owns the SVG and its own
 * reactivity (Selections → coordinator → client queries → re-render). Solid must
 * not reach inside. So this bridge is the whole contract — spec in (a list of
 * vgplot directives), a DOM element out, clean teardown on dispose — the same
 * discipline as aiui-viz's PlotFigure, but for a library that manages a *set* of
 * coordinator-connected clients rather than one self-contained figure.
 *
 * We build the Plot ourselves (rather than vgplot's `plot()` helper) for one
 * reason: to keep the marks, so disposal can `coordinator.disconnect` each and
 * not leak a client on every hot edit or theme flip. The spec is a reactive
 * thunk; reading a per-mode palette inside it makes a system theme change
 * rebuild the view against the surviving coordinator + selection (NOTES.md).
 */
import { Plot } from "@uwdata/mosaic-plot";
import { createEffect } from "solid-js";
import { store } from "../store";

export type Directive = (plot: Plot) => void;

export function MosaicView(props: { spec: () => Directive[]; class?: string }) {
  let host!: HTMLDivElement;
  createEffect(
    () => props.spec(),
    (directives) => {
      const p = new Plot(document.createElement("div"));
      for (const d of directives.flat()) d(p);
      for (const mark of p.marks) store.coordinator.connect(mark);
      // vgplot's own plot() calls update() argless for the initial full render;
      // the generated d.ts types the mark param as required, so pass undefined.
      p.update(undefined);
      host.replaceChildren(p.element);
      return () => {
        for (const mark of p.marks) store.coordinator.disconnect(mark);
        p.element.remove();
      };
    },
  );
  return <div class={props.class ? `mosaic-host ${props.class}` : "mosaic-host"} ref={host} />;
}
