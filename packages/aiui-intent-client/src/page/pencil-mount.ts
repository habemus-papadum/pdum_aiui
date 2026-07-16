/**
 * pencil-mount.ts — the in-page pencil surface: ONE `PencilSurface` that both
 * the local host input and a remote iPad draw on (owner, 2026-07-15; clean
 * reintegration 2026-07-16).
 *
 * This is the pencil's answer to `cdp/page-ink.ts`, and it mirrors it exactly —
 * because the two are the same shape: a floating markup surface mounted in the
 * target page, delivered the same way (bundled into the evaluated ink bundle for
 * the CDP tier; imported by the content script for MV3), driven by the same
 * mode-engine claim (`pencilSurface` ↔ `inkPointer`).
 *
 * The first integration passed `localInput: false` and hand-rolled a *pen-only*
 * capture shim that fed strokes through the `remote*` API, and it tore the
 * surface DOWN on every turn end. Both were wrong. `PencilSurface` was built to
 * be used like `InkSurface`:
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
 * `WRITE` — graphite dynamics, red lead. */
const MARKUP: PencilParams = { ...WRITE, color: "#e5484d" };

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

  const teardown = (): void => {
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
      return mounted?.surface.size() ?? { width: window.innerWidth, height: window.innerHeight };
    },
    remoteBegin(id, init) {
      ensureMounted().remoteBegin(id, init);
    },
    remotePoint(id, point) {
      mounted?.surface.remotePoint(id, point);
    },
    remoteEnd(id, point) {
      mounted?.surface.remoteEnd(id, point);
    },
    remoteCancel(id) {
      mounted?.surface.remoteCancel(id);
    },
    dispose: teardown,
  };
}
