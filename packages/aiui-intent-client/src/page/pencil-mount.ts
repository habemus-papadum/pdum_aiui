/**
 * pencil-mount.ts — the in-page pencil surface: ONE `PencilSurface` that both
 * the local host input and a remote iPad draw on (owner, 2026-07-15; clean
 * reintegration 2026-07-16).
 *
 * This is the pencil's markup surface for driven pages, and it keeps the
 * retired ink surface's contract exactly (aiui-pencil's `PencilSurface`
 * maintains that parity as its public shape — see aiui-pencil/src/surface.ts) —
 * because the two are the same shape: a floating markup surface mounted in the
 * target page, delivered the same way (bundled into the evaluated page bundle
 * for the CDP tier; imported by the content script for MV3), driven by the same
 * mode-engine claim (`pencilSurface`, née `inkPointer`).
 *
 * The first integration passed `localInput: false` and hand-rolled a *pen-only*
 * capture shim that fed strokes through the `remote*` API, and it tore the
 * surface DOWN on every turn end. Both were wrong. `PencilSurface` was built to
 * be used like its retired predecessor, aiui-ink's `InkSurface`:
 *
 *   - **native input, all devices.** `localInput: true` lets the surface own the
 *     pointer for mouse, pen, AND touch (surface.ts `bindLocalInput`). On the
 *     HOST that is exactly what we want — draw with whatever you have. Palm
 *     rejection ("only the pen when a stylus is present") is the REMOTE iPad
 *     client's job, expressed there as the surface's `shouldCapture` veto; it
 *     does not belong on the desktop.
 *   - **engage/disengage is `setActive`, not mount/dispose.** `engage` mounts
 *     once and `setActive(true)` (the canvas owns the pointer); `disengage`
 *     `setActive(false)` — the strokes STAY, the page owns the pointer again,
 *     exactly like ink leaving ink-mode (§13.6). The surface is disposed only on
 *     a real teardown (page unload / driver-death hard clean), or when vanishing
 *     ink has faded the last stroke away while inactive (`onAutoClear`).
 *
 * The remote iPad rides the SAME surface through the `remote*` API — the
 * panel's `HostSession` forwards `rbegin/rpoint/rend/rcancel`, and those land
 * beside the host's native strokes (the surface reports the two through separate
 * `onStrokeEnd` / `onRemoteStrokeEnd` callbacks). Local host input and the iPad
 * coexist; this file adds the former back without disturbing the latter.
 */

import {
  type PencilParams,
  PencilSurface,
  type PenSample,
  type Tool,
  WRITE,
} from "@habemus-papadum/aiui-pencil";

const HOST_ID = "__aiui-intent-pencil";

/** The markup pencil is a RED editing pencil on the host (ink's family colour is
 * `#ff5c87`; the pencil is a distinct, franker red). The instrument geometry is
 * `WRITE` — graphite dynamics, red lead. Exported: the remote pencil host
 * (pencil-host.ts) clamps every iPad stroke to THIS brush and declares its
 * color in the presentation, so the local pencil, the remote ink, and the
 * iPad's preview are all the same red. */
export const MARKUP: PencilParams = { ...WRITE, color: "#e5484d" };

export interface PencilHandle {
  /** Enter markup for the turn: mount once, then the surface owns the pointer. */
  engage(fadeSec: number): void;
  /** Leave markup (turn/claim released): stop owning the pointer — strokes STAY. */
  disengage(): void;
  /** Live vanishing lifetime, seconds (0 = persist). Restarts the clock when
   * switched on, so flipping vanish doesn't instantly evaporate old strokes. */
  setFade(fadeSec: number): void;
  /** The clear button — every stroke rides the charge-and-pop, then gone. */
  clear(): void;
  /** Undo the last committed stroke (an eraser undo restores the ink). */
  undo(): void;
  /** Whether anything is drawn (live, retained, or flattened) — ink parity. */
  hasInk(): boolean;
  /** The plane size, for the remote host (must equal the captured frame). */
  size(): { width: number; height: number };
  /** Remote iPad strokes, forwarded by the panel's HostSession. */
  remoteBegin(id: string, init: { tool: Tool; params: PencilParams; point: PenSample }): void;
  remotePoint(id: string, point: PenSample): void;
  remoteEnd(id: string, point?: PenSample): void;
  remoteCancel(id: string): void;
  /** Full teardown: remove the host from the page (page unload / hard clean). */
  dispose(): void;
}

export function mountPencil(): PencilHandle {
  let fadeSec = 0;
  let active = false;
  let mounted: { surface: PencilSurface; host: HTMLElement } | undefined;

  // ── document anchoring (the ink-era §13.6 contract, upgraded 2026-07-17).
  // Strokes mark CONTENT, so they follow it. Two mechanisms, layered:
  //
  //   WHILE scrolling — the host div is translated by the scroll delta since
  //   the anchor: every stroke glides with the page, smooth and free (local
  //   input self-corrects — the surface maps pointer events through the
  //   canvas's own bounding rect; remote points get the same shift at
  //   ingestion).
  //
  //   AT REST (debounced) — the surface REBASES: `translate` re-bakes every
  //   stroke shifted by the delta and the anchor moves to here, so the canvas
  //   always covers the viewport you are looking at. Stroke tiles are
  //   bounds-local, so ink rebased off-canvas keeps its points and pixels and
  //   re-bakes back into view when you scroll back — the overlay is a WINDOW
  //   over an unbounded drawing, never a clear. (The first cut retired at a
  //   scroll threshold; it read as "my ink vanished when I scrolled".)
  //
  // A RESIZE or ZOOM retires the markup with the animated clear —
  // UNCONDITIONALLY (owner, 2026-07-17: a threshold made it feel random;
  // reflow breaks coordinate anchoring either way, and D4's pop reads as
  // intentional where stale marks would silently detach from their content).
  // Content reflow is otherwise untracked — coordinates, not DOM anchors.
  let anchor = { x: 0, y: 0 };
  let vp = { w: 0, h: 0, dpr: 1 };
  let restTimer: ReturnType<typeof setTimeout> | undefined;

  const scrollNow = (): { x: number; y: number } => ({
    x: window.scrollX || 0,
    y: window.scrollY || 0,
  });
  const viewportNow = (): { w: number; h: number; dpr: number } => ({
    w: window.innerWidth,
    h: window.innerHeight,
    dpr: window.devicePixelRatio || 1,
  });

  /** Re-anchor HERE: re-bake the drawing shifted by the delta, reset the
   * glide transform. Idempotent at rest; cheap when nothing moved. */
  const rebase = (): void => {
    if (mounted === undefined) {
      return;
    }
    const s = scrollNow();
    const tx = anchor.x - s.x;
    const ty = anchor.y - s.y;
    if (tx !== 0 || ty !== 0) {
      mounted.surface.translate(tx, ty);
    }
    anchor = s;
    mounted.host.style.transform = "";
  };

  const applyAnchor = (): void => {
    if (mounted === undefined) {
      return;
    }
    const s = scrollNow();
    if (!mounted.surface.hasInk()) {
      anchor = s;
      mounted.host.style.transform = "";
      return;
    }
    const dx = anchor.x - s.x;
    const dy = anchor.y - s.y;
    mounted.host.style.transform = dx === 0 && dy === 0 ? "" : `translate(${dx}px, ${dy}px)`;
  };
  const onScroll = (): void => {
    applyAnchor();
    clearTimeout(restTimer);
    restTimer = setTimeout(rebase, 150);
  };

  /** ANY resize or zoom step: the reflow broke the anchoring — the ink fades
   * (the D4 pop), no thresholds (owner, 2026-07-17). */
  const onViewportChange = (): void => {
    const now = viewportNow();
    if (
      (now.w !== vp.w || now.h !== vp.h || now.dpr !== vp.dpr) &&
      mounted?.surface.hasInk() === true
    ) {
      mounted.surface.clearAnimated();
    }
    vp = now;
  };

  /** A frame-relative (viewport CSS px) point, shifted into the anchored
   * canvas's space — the remote twin of the local input's rect mapping. */
  const toAnchored = (point: PenSample): PenSample => {
    const s = scrollNow();
    const dx = s.x - anchor.x;
    const dy = s.y - anchor.y;
    return dx === 0 && dy === 0 ? point : { ...point, x: point.x + dx, y: point.y + dy };
  };

  /** A stroke is about to BEGIN at frame point (x, y) — mid-glide, before
   * the rest debounce lands. If the anchored mapping would fall outside the
   * canvas coverage, rebase NOW so the stroke lands on paper. Nothing is
   * lost: the rebase re-bakes, never clears. */
  const guardCoverage = (x: number, y: number): void => {
    if (mounted === undefined) {
      return;
    }
    const s = scrollNow();
    const cx = x + (s.x - anchor.x);
    const cy = y + (s.y - anchor.y);
    const size = mounted.surface.size();
    if (cx < 0 || cy < 0 || cx > size.width || cy > size.height) {
      rebase();
    }
  };

  const teardown = (): void => {
    window.removeEventListener("scroll", onScroll);
    window.removeEventListener("resize", onViewportChange);
    clearTimeout(restTimer);
    mounted?.surface.dispose();
    mounted?.host.remove();
    mounted = undefined;
    active = false;
  };

  const ensureMounted = (): PencilSurface => {
    if (mounted !== undefined) {
      return mounted.surface;
    }
    document.getElementById(HOST_ID)?.remove(); // a stale host from an earlier client
    const host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText =
      "position:fixed;inset:0;z-index:2147483643;pointer-events:none;touch-action:none;";
    document.documentElement.append(host);
    const surface = new PencilSurface({
      target: host,
      params: () => MARKUP,
      fadeSec: () => fadeSec,
      // Own the pointer natively — mouse, pen, AND touch (setActive gates it).
      // No `shouldCapture`: the host takes every device; palm rejection is the
      // remote client's veto, not the desktop's.
      localInput: true,
      // Float over the page, ink-on-transparent (NOT the scratchpad's paper).
      background: () => undefined,
      // Vanishing ink that faded its last stroke while we're not active: the
      // turn is over and nothing is left — remove the host (ink's onAutoClear).
      onAutoClear: () => {
        if (!active) {
          teardown();
        }
      },
    });
    mounted = { surface, host };
    anchor = scrollNow();
    vp = viewportNow();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onViewportChange);
    // Capture phase: runs before the surface's own canvas listener, so a
    // rebase here re-anchors the rect the surface is about to map through.
    host.addEventListener("pointerdown", (e) => guardCoverage(e.clientX, e.clientY), {
      capture: true,
    });
    return surface;
  };

  return {
    engage(fade) {
      fadeSec = fade;
      const surface = ensureMounted();
      surface.setActive(true);
      active = true;
    },
    disengage() {
      active = false;
      mounted?.surface.setActive(false); // strokes stay — §13.6, exactly like ink
    },
    setFade(fade) {
      const was = fadeSec;
      fadeSec = fade;
      // Turning vanishing ON restarts the fade clock — otherwise every stroke
      // older than the new window would pop the instant you flip the switch.
      if (fade > 0 && was === 0) {
        mounted?.surface.restartFade();
      }
    },
    clear() {
      mounted?.surface.clearAnimated();
    },
    undo() {
      mounted?.surface.undo();
    },
    hasInk() {
      return mounted?.surface.hasInk() ?? false;
    },
    size() {
      // The CAPTURED FRAME's CSS box, not the surface's: a tab capture (and
      // the CDP screencast) frames innerWidth×innerHeight — scrollbar
      // included — while the fixed-inset surface host stops at the scrollbar
      // (measured live 2026-07-17: 1063 vs 1051 CSS px, a ~1% horizontal skew
      // on every remote stroke). The remote plane must equal the frame; a
      // stroke aimed under the scrollbar clips harmlessly.
      return { width: window.innerWidth, height: window.innerHeight };
    },
    remoteBegin(id, init) {
      const surface = ensureMounted();
      guardCoverage(init.point.x, init.point.y);
      surface.remoteBegin(id, { ...init, point: toAnchored(init.point) });
    },
    remotePoint(id, point) {
      mounted?.surface.remotePoint(id, toAnchored(point));
    },
    remoteEnd(id, point) {
      mounted?.surface.remoteEnd(id, point !== undefined ? toAnchored(point) : undefined);
    },
    remoteCancel(id) {
      mounted?.surface.remoteCancel(id);
    },
    dispose: teardown,
  };
}
