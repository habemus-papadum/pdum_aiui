/**
 * embedding-view.tsx — the Solid bridge to Apple's `embedding-atlas`
 * EmbeddingViewMosaic: a WebGL point-cloud view of a 2-D embedding projection
 * that is a first-class Mosaic citizen — its `filter` prop is a Selection it
 * queries through, and its lasso/rectangle brush publishes clauses into a
 * `rangeSelection` Selection exactly like a vgplot interactor. Same seam
 * discipline as {@link ./mosaic}.MosaicView: durable coordinator + Selections
 * in, a DOM island out, producer-registry enrollment while mounted.
 *
 * What the wrapper adds over `new EmbeddingViewMosaic(el, props)`:
 *
 *  - **Reactive props.** One effect merges the declarative props with the
 *    `viewOptions` thunk (theme, category colors, config…) and routes changes
 *    through the component's own `update()` — a theme read inside the thunk
 *    re-skins the view against the surviving coordinator and selections,
 *    without rebuilding the Mosaic client.
 *  - **Host-fitted sizing.** The component takes literal width/height; the
 *    wrapper measures its host with a ResizeObserver and defers creation
 *    until the box has real extent (a 0×0 mount would fall back to 800×800).
 *  - **Producer identity.** The component publishes every clause (range,
 *    point selection, tooltip) from ONE internal MosaicClient, and installs a
 *    `reset()` on it — so that client object is the honest producer identity:
 *    `Selection.reset` clears the visuals through it, replace-by-source keys
 *    on it, crossfilter self-exclusion reads its `clients` set. The vanilla
 *    API never hands the client out, so the wrapper captures it with a thin
 *    forwarding facade on the `rangeSelection` prop (the one Selection prop
 *    the component uses without an `isSelection` brand check) and registers
 *    it in the producer registry under `name` — the inspector, `report()`,
 *    and `clear-selection` then attribute its clauses like any plot brush.
 *  - **Region adoption.** The captured client gets an `__aiuiDrive` hook
 *    (mosaic-facet.ts's self-driving-producer seam) that routes a driven
 *    value through `update({ rangeSelectionValue })` — the component draws
 *    the rectangle AND publishes the clause itself, so a pair of interval
 *    selectionDims bound to this producer gives agents a `set-<dim>` that
 *    moves the on-screen region, and a mouse lasso mirrors back into the
 *    dims. (A freehand lasso publishes a polygon; the dims mirror its
 *    bounding box — the clause keeps the exact polygon.)
 *
 * No ghost-clause retraction here, unlike MosaicView: the component's own
 * unmount cleanups retract every clause it published (verified in
 * EmbeddingViewMosaic.svelte, 0.24) — `destroy()` is the retraction.
 *
 * Lives on its own subpath (`@habemus-papadum/aiui-viz/embedding`) so
 * `embedding-atlas` stays an optional peer only its consumers install.
 */
import { EmbeddingViewMosaic, type EmbeddingViewMosaicProps } from "embedding-atlas";
import { createEffect, createSignal, onCleanup } from "solid-js";
import type { MosaicCoordinator } from "./mosaic";
import { AIUI_DRIVE } from "./mosaic-facet";
import { registerMosaicInput } from "./mosaic-registry";
import type { Scope } from "./scope";

/** The slice of a Selection clause the facade inspects. */
interface ClauseLike {
  source?: object;
}

/**
 * The slice of a Mosaic `Selection` the embedding view drives — structural,
 * so this module adds no `@uwdata/mosaic-core` dependency; pass the real
 * durable Selections your views coordinate on.
 */
export interface EmbeddingSelectionLike {
  update(clause: unknown): unknown;
  activate?(clause: unknown): unknown;
}

/**
 * Mount one coordinator-connected embedding view. `viewOptions` is a reactive
 * thunk merged over the declarative props — read a per-mode palette inside it
 * (theme, categoryColors, `config.colorScheme`) and a system theme flip
 * re-skins the view in place. With `name`, the view's internal clause source
 * registers in the producer registry (fields `[x, y]`, kind "interval") so
 * the inspector and the agent surface can name it, and a paired
 * `bindSelectionComponents` region binding can adopt it.
 */
export function EmbeddingView(props: {
  coordinator: MosaicCoordinator;
  /** The data table name (already loaded in the coordinator's DuckDB). */
  table: string;
  /** X/Y projection column names. */
  x: string;
  y: string;
  /** 0-indexed integer category column (see embedding-atlas docs). */
  category?: string | null;
  /** Text column — tooltip content and automatic cluster labels. */
  text?: string | null;
  /** Unique-id column: selections then carry an `identifier`. */
  identifier?: string | null;
  /** Selection filtering THIS view's points (usually the crossfilter). */
  filter?: EmbeddingSelectionLike | null;
  /** Selection the view's rectangle/lasso brush publishes into. */
  rangeSelection?: EmbeddingSelectionLike | null;
  /** Selection (or value) for point picks — passed through verbatim. */
  selection?: EmbeddingViewMosaicProps["selection"];
  /** Selection (or value) for the tooltip — passed through verbatim. */
  tooltip?: EmbeddingViewMosaicProps["tooltip"];
  /** Reactive extras merged last: theme, categoryColors, config, labels,
   *  callbacks… — anything from EmbeddingViewMosaicProps. */
  viewOptions?: () => Partial<EmbeddingViewMosaicProps>;
  /** Start the view with a selection tool engaged — "marquee" (rectangle)
   *  or "lasso" — so a plain drag SELECTS instead of panning (shift+drag
   *  then pans). The component holds this state internally with no public
   *  prop (0.24 initializes it to "none"), so the wrapper presses the
   *  status bar's own toggle button — the same path a user's click takes.
   *  Needs the status bar (on by default). Read once per component build. */
  initialSelectionMode?: "marquee" | "lasso";
  /** `false` disables wheel-zoom: wheel events are swallowed at the host in
   *  the capture phase, so they neither reach the component's canvas (no
   *  zoom) nor bubble to a scroll-interpreting shell (a slide deck doesn't
   *  navigate mid-hover either) — the view simply ignores the wheel.
   *  Default: the component's own behavior (wheel zooms). Read at mount. */
  wheelZoom?: boolean;
  /** Producer-registry enrollment (with `scope`), like MosaicView's. */
  scope?: Scope | string;
  name?: string;
  class?: string;
}) {
  let host!: HTMLDivElement;
  let component: EmbeddingViewMosaic | undefined;
  let disposed = false;
  let registered: { source: object; unregister: () => void } | undefined;
  // Snapshotted by the effect for the (non-reactive) capture path.
  let meta: {
    scope?: Scope | string;
    name?: string;
    fields: [string, string];
    selection: EmbeddingSelectionLike;
  } | null = null;

  const [size, setSize] = createSignal<{ w: number; h: number } | undefined>(undefined);

  /** Enroll one captured clause source; re-registration replaces (the
   * component rebuilds its client when coordinator/table/columns change). */
  const capture = (source: object): void => {
    if (disposed || registered?.source === source || meta?.name === undefined) return;
    registered?.unregister();
    registered = undefined;
    // The adoption hook: driving this producer routes through the component's
    // own rangeSelectionValue prop — it draws the region AND publishes the
    // clause from this same source. Non-enumerable, like the dim seam.
    Object.defineProperty(source, AIUI_DRIVE, {
      value: (cv: unknown) => {
        component?.update({
          rangeSelectionValue: cv as EmbeddingViewMosaicProps["rangeSelectionValue"],
        });
      },
      configurable: true,
    });
    const m = meta;
    if (m?.name === undefined) return;
    // Deferred: capture fires inside the component's own effect flush;
    // registry listeners (the facet binder) may immediately drive back into
    // update(), which must not re-enter that flush.
    queueMicrotask(() => {
      if (disposed || meta?.name === undefined || registered !== undefined) return;
      const unregister = registerMosaicInput({
        ...(m.scope !== undefined ? { scope: m.scope } : {}),
        name: m.name as string,
        input: source,
        selection: m.selection,
        fields: m.fields,
        kind: "interval",
      });
      registered = { source, unregister };
    });
  };

  /** Forwarding facade: the component publishes range clauses through this,
   * which is how the wrapper learns the internal client's identity. */
  const facade: EmbeddingSelectionLike = {
    update: (clause: unknown) => {
      const src = (clause as ClauseLike | null)?.source;
      const real = meta?.selection;
      if (real === undefined) return undefined;
      const result = real.update(clause);
      if (src !== undefined) capture(src);
      return result;
    },
    activate: (clause: unknown) => meta?.selection?.activate?.(clause),
  };

  /** The status-bar toggle titles are the only stable handle on the
   * component's internal selection-mode state (see initialSelectionMode). */
  const MODE_BUTTON_TITLE = {
    marquee: "Toggle rectangle selection mode",
    lasso: "Toggle lasso selection mode",
  } as const;

  /** Engage `initialSelectionMode` on a freshly built component by clicking
   * its own status-bar toggle (a fresh component always starts at "none",
   * so one click = engaged, never toggled back off). The status bar mounts
   * with the component; the short retry loop covers a late frame. */
  const engageSelectionMode = (forComponent: EmbeddingViewMosaic): void => {
    const mode = props.initialSelectionMode;
    if (mode === undefined) return;
    let tries = 0;
    const attempt = (): void => {
      if (disposed || component !== forComponent) return;
      const btn = host.querySelector<HTMLElement>(`[title^="${MODE_BUTTON_TITLE[mode]}"]`);
      if (btn !== null) btn.click();
      else if (++tries < 40) setTimeout(attempt, 50);
    };
    queueMicrotask(attempt);
  };

  /** wheelZoom === false: capture-phase swallow on the host (see the prop). */
  const swallowWheel = (e: WheelEvent): void => {
    e.stopPropagation();
    e.preventDefault();
  };

  const apply = (w: number, h: number): void => {
    if (w > 0 && h > 0) setSize({ w: Math.round(w), h: Math.round(h) });
  };
  const observer = new ResizeObserver((entries) => {
    const box = entries[0]?.contentRect;
    if (box !== undefined) apply(box.width, box.height);
  });
  /** Direct measurement fallback: RO/rAF delivery pauses entirely while the
   * window is occluded (Chrome stops the rendering pipeline; layout still
   * computes), so waiting for the first RO callback would leave the view
   * unmounted until the window is next actually seen. Measure once after
   * insertion; RO takes over for real resizes. */
  const measure = (): void => {
    if (!disposed && host !== undefined) apply(host.clientWidth, host.clientHeight);
  };

  onCleanup(() => {
    disposed = true;
    if (host !== undefined) host.removeEventListener("wheel", swallowWheel, { capture: true });
    observer.disconnect();
    registered?.unregister();
    registered = undefined;
    // destroy() IS the clause retraction: the component's unmount cleanups
    // republish every clause it holds with a null predicate.
    component?.destroy();
    component = undefined;
  });

  createEffect(
    () => {
      const s = size();
      const range = props.rangeSelection ?? null;
      const merged: Partial<EmbeddingViewMosaicProps> = {
        coordinator: props.coordinator as EmbeddingViewMosaicProps["coordinator"],
        table: props.table,
        x: props.x,
        y: props.y,
        category: props.category ?? null,
        text: props.text ?? null,
        identifier: props.identifier ?? null,
        filter: (props.filter ?? null) as EmbeddingViewMosaicProps["filter"],
        selection: props.selection ?? null,
        tooltip: props.tooltip ?? null,
        rangeSelection: (range !== null
          ? facade
          : null) as EmbeddingViewMosaicProps["rangeSelection"],
        ...(s !== undefined ? { width: s.w, height: s.h } : {}),
        ...props.viewOptions?.(),
      };
      return {
        merged,
        ready: s !== undefined,
        meta: {
          ...(props.scope !== undefined ? { scope: props.scope } : {}),
          ...(props.name !== undefined ? { name: props.name } : {}),
          fields: [props.x, props.y] as [string, string],
          selection: range ?? { update: () => undefined },
        },
      };
    },
    (v) => {
      meta = v.meta;
      if (!v.ready) return;
      if (component === undefined) {
        component = new EmbeddingViewMosaic(host, v.merged as EmbeddingViewMosaicProps);
        engageSelectionMode(component);
      } else {
        component.update(v.merged);
      }
    },
  );

  return (
    <div
      class={props.class ? `embedding-host ${props.class}` : "embedding-host"}
      ref={(el) => {
        host = el;
        // Mount-time read (no owner here; removal rides the body onCleanup).
        if (props.wheelZoom === false) {
          el.addEventListener("wheel", swallowWheel, { capture: true, passive: false });
        }
        // The ref runs pre-insertion; measure after this render flush lands.
        queueMicrotask(measure);
        observer.observe(el);
      }}
    />
  );
}
