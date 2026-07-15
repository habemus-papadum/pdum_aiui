/**
 * pencil-mount.ts — the in-page pencil surface: ONE `PencilSurface` that both
 * the local stylus and a remote iPad draw on (owner, 2026-07-15).
 *
 * This is the pencil's answer to `cdp/page-ink.ts`: a markup surface mounted in
 * the target page, delivered the same way (bundled into the evaluated ink
 * bundle for the CDP tier; imported by the content script for MV3). The pencil
 * supersedes ink's `InkSurface` for this surface, but ink stays wired in
 * parallel — this is additive.
 *
 * The design choice that shapes the file: the surface NEVER blocks the page.
 * `PencilSurface.setActive(true)` makes the canvas `pointer-events: auto` — a
 * full-viewport overlay that swallows every click (surface.ts records that
 * footgun). So we mount with `localInput: false` (the canvas stays
 * `pointer-events: none`) and feed it two ways, BOTH through the same
 * `remote*` API:
 *
 *   - **local stylus** — a capture-phase pointer listener that intercepts only
 *     `pointerType === "pen"` (a real stylus / Apple Pencil on the desktop),
 *     `preventDefault`s it so the page never also sees the pen, and feeds it as
 *     a stroke. Mouse and touch fall straight through to the page — you draw
 *     with the pen and keep using the page with everything else. A pencil is a
 *     stylus instrument (pressure/tilt); a mouse has no business drawing one.
 *   - **remote iPad** — the panel's `HostSession` forwards the iPad's strokes
 *     over the page transport as `rbegin/rpoint/rend/rcancel` ops (Phase 2);
 *     they land on this same surface, so the desktop human sees the marks.
 *
 * Engagement is per-turn: `engage(fadeSec)` mounts and starts listening,
 * `disengage()` tears down (the turn ended — nothing outlives it). The three
 * user-facing knobs ride here: fade lifetime (`setFade`), the clear
 * (`clearAnimated`), and vanishing-on/off (fade 0 vs >0).
 */

import {
  type PencilParams,
  PencilSurface,
  type PenSample,
  penSample,
  type Tool,
  WRITE,
} from "@habemus-papadum/aiui-pencil";

const HOST_ID = "__aiui-intent-pencil";

export interface PencilHandle {
  /** Enter markup for the turn: mount the surface, listen for the local pen. */
  engage(fadeSec: number): void;
  /** Leave markup (turn ended): stop listening and dispose (clears the ink). */
  disengage(): void;
  /** Live vanishing lifetime, seconds (0 = persist). Restarts the clock when
   * switched on, so flipping vanish doesn't instantly evaporate old strokes. */
  setFade(fadeSec: number): void;
  /** The clear button — every stroke rides the charge-and-pop, then gone. */
  clear(): void;
  /** Undo the last committed stroke (an eraser undo restores the ink). */
  undo(): void;
  /** The plane size, for the remote host (must equal the captured frame). */
  size(): { width: number; height: number };
  /** Remote iPad strokes, forwarded by the panel's HostSession (Phase 2). */
  remoteBegin(id: string, init: { tool: Tool; params: PencilParams; point: PenSample }): void;
  remotePoint(id: string, point: PenSample): void;
  remoteEnd(id: string, point?: PenSample): void;
  remoteCancel(id: string): void;
  dispose(): void;
}

export function mountPencil(): PencilHandle {
  let host: HTMLElement | undefined;
  let surface: PencilSurface | undefined;
  let fadeSec = 0;
  let localId = 0;
  let activePointer: number | undefined;
  let activeStroke: string | undefined;

  const ensureMounted = (): PencilSurface => {
    if (surface !== undefined) {
      return surface;
    }
    document.getElementById(HOST_ID)?.remove(); // a stale host from an earlier client
    const el = document.createElement("div");
    el.id = HOST_ID;
    el.style.cssText =
      "position:fixed;inset:0;z-index:2147483643;pointer-events:none;touch-action:none;";
    document.documentElement.append(el);
    host = el;
    surface = new PencilSurface({
      target: el,
      params: () => WRITE,
      fadeSec: () => fadeSec,
      // Never own the pointer — we route the pen ourselves (see the module doc).
      localInput: false,
      // Float over the page, ink-on-transparent (NOT the scratchpad's paper).
      background: () => undefined,
    });
    return surface;
  };

  // ── the local pen: capture-phase, pen only, page keeps the rest ─────────────
  const onDown = (event: PointerEvent): void => {
    if (event.pointerType !== "pen" || activePointer !== undefined) {
      return; // mouse/touch fall through to the page; one pen at a time
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    const s = ensureMounted();
    activePointer = event.pointerId;
    localId += 1;
    activeStroke = `local-${localId}`;
    s.remoteBegin(activeStroke, {
      tool: "draw",
      params: WRITE,
      point: penSample(event),
    });
  };
  const onMove = (event: PointerEvent): void => {
    if (event.pointerId !== activePointer || activeStroke === undefined) {
      return;
    }
    event.preventDefault();
    surface?.remotePoint(activeStroke, penSample(event));
  };
  const endLocal = (event: PointerEvent, cancel: boolean): void => {
    if (event.pointerId !== activePointer || activeStroke === undefined) {
      return;
    }
    event.preventDefault();
    if (cancel) {
      surface?.remoteCancel(activeStroke);
    } else {
      surface?.remoteEnd(activeStroke, penSample(event));
    }
    activePointer = undefined;
    activeStroke = undefined;
  };
  const onUp = (event: PointerEvent): void => endLocal(event, false);
  const onCancel = (event: PointerEvent): void => endLocal(event, true);

  let listening = false;
  const listen = (on: boolean): void => {
    if (on === listening) {
      return;
    }
    listening = on;
    const fn = on ? document.addEventListener : document.removeEventListener;
    fn.call(document, "pointerdown", onDown as EventListener, true);
    fn.call(document, "pointermove", onMove as EventListener, true);
    fn.call(document, "pointerup", onUp as EventListener, true);
    fn.call(document, "pointercancel", onCancel as EventListener, true);
  };

  const teardown = (): void => {
    listen(false);
    surface?.dispose();
    surface = undefined;
    host?.remove();
    host = undefined;
    activePointer = undefined;
    activeStroke = undefined;
  };

  return {
    engage(fade) {
      fadeSec = fade;
      ensureMounted();
      listen(true);
    },
    disengage: teardown,
    setFade(fade) {
      const was = fadeSec;
      fadeSec = fade;
      // Turning vanishing ON restarts the fade clock — otherwise every stroke
      // older than the new window would pop the instant you flip the switch.
      if (fade > 0 && was === 0) {
        surface?.restartFade();
      }
    },
    clear() {
      surface?.clearAnimated();
    },
    undo() {
      surface?.undo();
    },
    size() {
      return surface?.size() ?? { width: window.innerWidth, height: window.innerHeight };
    },
    remoteBegin(id, init) {
      ensureMounted().remoteBegin(id, init);
    },
    remotePoint(id, point) {
      surface?.remotePoint(id, point);
    },
    remoteEnd(id, point) {
      surface?.remoteEnd(id, point);
    },
    remoteCancel(id) {
      surface?.remoteCancel(id);
    },
    dispose: teardown,
  };
}
