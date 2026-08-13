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
import { type MosaicPlotLike, registerMosaicPlot } from "./mosaic-registry";
import type { Scope } from "./scope";

/** One vgplot directive (`vg.raster(...)`, `vg.width(...)`, …) applied to the Plot. */
export type Directive = (plot: Plot) => void;

/**
 * The slice of a Selection clause / interactor this bridge's disposal needs —
 * structural (like {@link MosaicCoordinator}) so nothing here depends on
 * `@uwdata/mosaic-core`'s types. Every clause-publishing vgplot interactor
 * (Interval1D/2D, Toggle, Nearest, Region, Highlight) carries `.selection`;
 * ones that publish nothing (PanZoom) simply lack it and are skipped.
 */
interface SelectionClauseLike {
  source: unknown;
  value?: unknown;
  predicate?: unknown;
}
interface InteractorLike {
  selection?: {
    clauses: readonly SelectionClauseLike[];
    update(clause: SelectionClauseLike): unknown;
  };
}

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
  /** With `name`, register this view's interactors in the producer registry
   * (mosaic-registry.ts) so the inspector and the agent surface can name
   * them ("seismos/map"). Re-renders re-register; disposal unregisters. */
  scope?: Scope | string;
  name?: string;
}) {
  let host!: HTMLDivElement;
  // The coordinator rides through the compute: a props read is reactive, and
  // reading it in the untracked handler (or the cleanup) both warns
  // STRICT_READ_UNTRACKED and would go stale if the prop ever changed —
  // consume what the source computed (frontend-hard-won.md).
  createEffect(
    () => ({
      directives: props.spec(),
      coordinator: props.coordinator,
      scope: props.scope,
      name: props.name,
    }),
    ({ directives, coordinator, scope, name }) => {
      const p = new Plot(document.createElement("div"));
      for (const d of directives.flat()) d(p);
      for (const mark of p.marks) coordinator.connect(mark);
      // vgplot's own plot() calls update() argless for the initial full render;
      // the generated d.ts types the mark param as required, so pass undefined.
      p.update(undefined);
      host.replaceChildren(p.element);
      const unregister =
        name !== undefined
          ? registerMosaicPlot({ scope, name, plot: p as unknown as MosaicPlotLike })
          : undefined;
      return () => {
        unregister?.();
        for (const mark of p.marks) coordinator.disconnect(mark);
        // Interactors are NOT marks, and their published clauses live in the
        // SURVIVING selection keyed by interactor instance — Mosaic only
        // replaces a clause arriving from the same source object, so a view
        // disposed mid-brush would otherwise leave a ghost clause AND-ing
        // every future brush, with no rectangle on screen to explain it.
        // Publishing the clause back with a null predicate from its own
        // source is the retraction the interactors themselves use for an
        // empty brush (Interval1D.publish with a cleared extent).
        for (const interactor of p.interactors as InteractorLike[]) {
          const selection = interactor.selection;
          if (selection === undefined) continue;
          const clause = selection.clauses.find((c) => c.source === interactor);
          if (clause !== undefined) {
            selection.update({ ...clause, value: null, predicate: null });
          }
        }
        p.element.remove();
      };
    },
  );
  return <div class={props.class ? `mosaic-host ${props.class}` : "mosaic-host"} ref={host} />;
}
