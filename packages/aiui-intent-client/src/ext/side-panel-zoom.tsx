/**
 * side-panel-zoom.tsx — panel zoom, EXTENSION SIDE PANEL ONLY (owner, 2026-07-16).
 *
 * Three tiny buttons in the panel's top-right corner:  −  ·  the current %  ·  +
 * (the middle one is the readout AND the reset — click it for 100%). This
 * REPLACES the keyboard chord: ⌘+/⌘−/⌘0 are the browser's own accelerators and
 * never reach a side panel, and the ⌘⇧… workaround was more confusing than a
 * visible control (owner call, 2026-07-16).
 *
 * Why it exists at all: browser zoom does not reach an MV3 side panel. The plain
 * page the channel serves has real browser zoom, so it renders NONE of this —
 * only ext/panel.tsx mounts the component. It is `position: fixed`, so it floats
 * in the corner over the panel without disturbing the layout.
 *
 * Two halves, both here: the buttons (step the `uiScale` control — which clamps
 * to [min,max] and snaps the step itself) and the APPLY effect (uiScale → root
 * font-size), which runs immediately with the restored value so a saved zoom
 * lands on the document at boot.
 */

import type { JSX } from "@solidjs/web";
import { createEffect } from "solid-js";
import { uiScale } from "../config";

const pct = (scale: number): string => `${Math.round(scale * 100)}%`;

const ZOOM_STYLES = `
  .aiui-zoom { position: fixed; top: 6px; right: 8px; z-index: 2147482000;
    display: inline-flex; align-items: stretch; opacity: 0.45;
    transition: opacity 120ms ease; font: 11px system-ui; }
  .aiui-zoom:hover, .aiui-zoom:focus-within { opacity: 1; }
  .aiui-zoom button { font: inherit; line-height: 1; cursor: pointer; color: inherit;
    background: color-mix(in srgb, Canvas 80%, transparent);
    border: 1px solid color-mix(in srgb, CanvasText 22%, transparent);
    padding: 2px 7px; }
  .aiui-zoom button:not(:first-child) { border-left: none; }
  .aiui-zoom button:first-child { border-radius: 6px 0 0 6px; }
  .aiui-zoom button:last-child { border-radius: 0 6px 6px 0; }
  .aiui-zoom button:hover { background: color-mix(in srgb, Canvas 55%, CanvasText 10%); }
  .aiui-zoom .aiui-zoom-pct { min-width: 3.6em; text-align: center;
    font-variant-numeric: tabular-nums; }
`;

export function SidePanelZoom(): JSX.Element {
  // Apply half: uiScale → the document's CSS `zoom` (browser zoom can't reach a
  // side panel). NOT a root font-size — every size in this panel is px, so a
  // percentage font-size scales nothing (found live: the % readout moved, the
  // panel did not). The `zoom` property magnifies the whole document, px and all;
  // it is non-standard but the side panel is always Chrome, which supports it.
  // Two-arg createEffect (compute, effect); it runs immediately, so the scale
  // restored by loadConfigBase() lands on the document at boot.
  createEffect(
    () => uiScale.get() as number,
    (scale) => {
      document.documentElement.style.setProperty("zoom", String(scale));
    },
  );

  // Step through the UPDATER form, never get()+set(): Solid stages writes, so a
  // fast double-click would otherwise compute both steps off one stale value.
  // The control clamps to [min,max] and snaps to the step for us.
  const step = (delta: number) => (): void => {
    uiScale.set(((prev: number) => prev + delta) as never);
  };

  return (
    <>
      <style>{ZOOM_STYLES}</style>
      <div class="aiui-zoom" data-testid="panel-zoom">
        <button type="button" title="smaller (zoom out)" aria-label="zoom out" onClick={step(-0.1)}>
          −
        </button>
        <button
          type="button"
          class="aiui-zoom-pct"
          title="reset zoom to 100%"
          aria-label="reset zoom"
          onClick={() => uiScale.set(1 as never)}
        >
          {pct(uiScale.get() as number)}
        </button>
        <button type="button" title="larger (zoom in)" aria-label="zoom in" onClick={step(0.1)}>
          +
        </button>
      </div>
    </>
  );
}
