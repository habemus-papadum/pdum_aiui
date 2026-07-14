/**
 * page-ink.ts — the REAL ink surface for CDP-driven pages, served from the
 * channel origin and dynamic-imported by the injected bootstrap (the tiny
 * bootstrap stays dependency-free; the heavy module arrives as an ES module
 * over the same Vite middleware that serves the panel — source-first, CORS
 * comes with Vite dev).
 *
 * The mounting is the old content script's, chrome-free: shadow-DOM host,
 * document-anchored strokes (§13.6 — the page is a whiteboard you talk
 * over), live fade the panel re-relays, stroke facts reported back through
 * the bootstrap's binding.
 */

import { boundsOf, InkSurface } from "@habemus-papadum/aiui-ink";

const INK_HOST_ID = "__aiui-intent-ink";

export interface InkHandle {
  /** Enter/leave ink MODE (pointer ownership); strokes persist across off. */
  setOn(on: boolean, fadeSec: number): void;
  /** Erase the strokes (the panel's C / disarm — the only clears). */
  clear(): void;
  dispose(): void;
}

export function mountInk(reportStroke: (points: number) => void): InkHandle {
  let fadeSec = 0;
  let active = false;
  let mounted: { surface: InkSurface; host: HTMLElement } | undefined;

  const ensureMounted = (): void => {
    if (mounted !== undefined) {
      return;
    }
    document.getElementById(INK_HOST_ID)?.remove(); // a stale host from an earlier client
    const host = document.createElement("div");
    host.id = INK_HOST_ID;
    const shadow = host.attachShadow({ mode: "open" });
    const layer = document.createElement("div");
    layer.style.cssText = "position: fixed; inset: 0; z-index: 2147483645; pointer-events: none;";
    shadow.append(layer);
    document.documentElement.append(host);
    const surface = new InkSurface({
      target: layer,
      fadeSec: () => fadeSec, // live: the panel's fade slider needs no remount
      documentAnchored: true,
      onStrokeEnd: (stroke) => {
        reportStroke(stroke.points.length);
        void boundsOf; // bounds relay with the shot/stroke enrichment (post-v1)
      },
      onAutoClear: () => {
        if (!active) {
          unmount(); // faded away after mode exit — nothing left to keep
        }
      },
    });
    mounted = { surface, host };
  };

  const unmount = (): void => {
    mounted?.surface.dispose();
    mounted?.host.remove();
    mounted = undefined;
    active = false;
  };

  return {
    setOn(on, fade) {
      fadeSec = fade;
      if (on) {
        ensureMounted();
        mounted?.surface.setActive(true);
        active = true;
      } else {
        active = false;
        mounted?.surface.setActive(false); // strokes stay — §13.6
      }
    },
    clear() {
      mounted?.surface.clear(false);
      if (!active) {
        unmount();
      }
    },
    dispose: unmount,
  };
}

// The component locator rides the same evaluated bundle: the bootstrap calls
// `__aiuiIntentInk.locateComponents(rect)` when a region drag completes on an
// aiui-instrumented page (data-source-loc stamps → LocatedComponent[]).
export { locateComponents } from "@habemus-papadum/aiui-dev-overlay/multimodal-shot";
