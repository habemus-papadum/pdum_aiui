/**
 * surfaces.ts — the page-side visual/gesture surfaces, one implementation for
 * BOTH hosts. Each factory closes over nothing at module scope and touches only
 * browser globals, so it is safe two ways: the MV3 content script imports it
 * normally, and `buildPageScript` (cdp/page-script.ts) stringifies each factory
 * `.toString()` into the injected bootstrap and passes them as arguments.
 *
 * The hard contract: **this module must stay import-free at the VALUE level.**
 * A value import would leave a free variable in the stringified function body
 * that does not exist in the injected page — the bootstrap fetches nothing.
 * Type-only imports are fine; they erase before stringification.
 */

import type { PageReport } from "../cdp/page-script";
import type { PageCapabilityMap } from "../transport";
import type { PencilHandle } from "./pencil-mount";

/** The region-drag report — the only PageReport a region surface emits. */
type RegionReport = Extract<PageReport, { kind: "region" }>;

/** The on-page indicator ring: off · steady (armed) · breathing (turn) ·
 * HOLLOW (armed, but this tab's pixels need a grant). The hint text is handed
 * down by the host (the live activation shortcut) — the page never knows the
 * key. Ids/colors/CSS are the page's public footprint; keep them stable. */
export function createRingSurface(): {
  assert(on: boolean, turnTone: boolean, hollow: boolean, hint: string): void;
} {
  let ring: HTMLElement | undefined;
  let ringHint: HTMLElement | undefined;
  const assert = (on: boolean, turnTone: boolean, hollow: boolean, hint: string): void => {
    if (!on) {
      ring?.remove();
      ringHint?.remove();
      ring = undefined;
      ringHint = undefined;
      return;
    }
    if (ring === undefined || !ring.isConnected) {
      ring = document.createElement("div");
      ring.id = "__aiui-intent-ring";
      ring.style.cssText =
        "position:fixed;top:8px;right:8px;width:12px;height:12px;border-radius:50%;" +
        "box-sizing:border-box;z-index:2147483646;pointer-events:none;transition:background 200ms;";
      const style = document.createElement("style");
      style.textContent =
        "@keyframes __aiui-breathe{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(.8)}}";
      ring.appendChild(style);
      (document.body ?? document.documentElement).appendChild(ring);
    }
    const color = turnTone ? "#dc2626" : "#7c3aed";
    ring.style.background = hollow ? "transparent" : color;
    ring.style.border = hollow ? `2px solid ${color}` : "0";
    ring.style.animation = turnTone ? "__aiui-breathe 1.6s ease-in-out infinite" : "none";
    if (hollow && hint !== "") {
      if (ringHint === undefined || !ringHint.isConnected) {
        ringHint = document.createElement("div");
        ringHint.id = "__aiui-intent-ring-hint";
        ringHint.style.cssText =
          "position:fixed;top:7px;right:24px;z-index:2147483646;pointer-events:none;" +
          "font:11px/14px ui-monospace,SFMono-Regular,Menlo,monospace;padding:0 5px;" +
          "border-radius:7px;background:rgba(0,0,0,.55);color:#fff;";
        (document.body ?? document.documentElement).appendChild(ringHint);
      }
      ringHint.textContent = hint;
    } else {
      ringHint?.remove();
      ringHint = undefined;
    }
  };
  return { assert };
}

/** The full-frame flash wash: shot confirmation (blue) / miss feedback (red). */
export function createFlash(): (kind: string) => void {
  return (kind: string): void => {
    const wash = document.createElement("div");
    wash.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;pointer-events:none;transition:opacity 220ms;" +
      `background:${kind === "miss" ? "rgba(220,38,38,.25)" : "rgba(147,197,253,.35)"};`;
    (document.body ?? document.documentElement).appendChild(wash);
    requestAnimationFrame(() => {
      wash.style.opacity = "0";
      setTimeout(() => wash.remove(), 260);
    });
  };
}

/** The region rubber band: a ONE-SHOT drag overlay (the `a` area shot). The
 * host supplies `report` (where the finished rect goes) and, on aiui pages,
 * `locate` (the rect → components lookup — a DOM read on both tiers, sourced
 * differently: a direct import in the isolated world, the injected bundle's
 * global in the page world). */
export function createRegionSurface(deps: {
  report(r: RegionReport): void;
  locate?(rect: { x: number; y: number; w: number; h: number }): unknown[] | undefined;
}): { arm(): void; disarm(): void } {
  let regionOverlay: HTMLElement | undefined;
  const disarm = (): void => {
    regionOverlay?.remove();
    regionOverlay = undefined;
  };
  const arm = (): void => {
    disarm(); // re-arm replaces
    const overlay = document.createElement("div");
    overlay.id = "__aiui-intent-region";
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:2147483646;cursor:crosshair;background:rgba(124,58,237,.06);";
    const band = document.createElement("div");
    band.style.cssText =
      "position:fixed;border:2px solid #7c3aed;background:rgba(124,58,237,.12);display:none;" +
      "pointer-events:none;";
    overlay.appendChild(band);
    let start: { x: number; y: number } | undefined;
    const rectNow = (e: PointerEvent) => {
      const s0 = start ?? { x: e.clientX, y: e.clientY };
      return {
        x: Math.min(s0.x, e.clientX),
        y: Math.min(s0.y, e.clientY),
        w: Math.abs(e.clientX - s0.x),
        h: Math.abs(e.clientY - s0.y),
      };
    };
    overlay.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      start = { x: e.clientX, y: e.clientY };
      overlay.setPointerCapture(e.pointerId);
    });
    overlay.addEventListener("pointermove", (e) => {
      if (start === undefined) {
        return;
      }
      const r = rectNow(e);
      band.style.display = "block";
      band.style.left = `${r.x}px`;
      band.style.top = `${r.y}px`;
      band.style.width = `${r.w}px`;
      band.style.height = `${r.h}px`;
    });
    overlay.addEventListener("pointerup", (e) => {
      const r = start !== undefined ? rectNow(e) : undefined;
      disarm();
      if (r === undefined || r.w < 4 || r.h < 4) {
        return; // a click, not a drag — cancelled
      }
      let components: unknown[] | undefined;
      try {
        components = deps.locate?.(r);
      } catch {
        components = undefined;
      }
      deps.report({
        kind: "region",
        rect: r,
        viewport: { w: window.innerWidth, h: window.innerHeight },
        takenAt: Date.now(),
        ...(components !== undefined && components.length > 0 ? { components } : {}),
      });
    });
    // No private Escape listener (owner, 2026-07-16): area is a mode-engine
    // TOGGLE, and Escape unwinds it through the panel's escOrder — the in-turn
    // key layer forwards Escape to the panel, which flips `region` off, and the
    // region surface claim lowers this overlay. One Escape source, no split-brain.
    (document.body ?? document.documentElement).appendChild(overlay);
    regionOverlay = overlay;
  };
  return { arm, disarm };
}

/** The pencil `{op, …}` dispatcher: engage/disengage/fade/clear/undo and the
 * forwarded iPad remote ops. `getMount` hands over the mount factory — imported
 * directly in the isolated world (always present), read off the injected bundle
 * in the page world (absent until the bundle lands, hence the engage guard). A
 * `size` op answers the FRAME box (innerWidth×innerHeight — a capture frames the
 * scrollbar too), a window fact never gated on the mount. Ops before an engage
 * are tolerated as no-ops (a stray op after disengage). */
export function createPencilOps(
  getMount: () => (() => PencilHandle) | undefined,
): (payload: Record<string, unknown>) => PageCapabilityMap["pencil"]["reply"] {
  let handle: PencilHandle | undefined;
  return (payload: Record<string, unknown>): PageCapabilityMap["pencil"]["reply"] => {
    const op = String(payload.op ?? "");
    if (op === "size") {
      return { width: window.innerWidth, height: window.innerHeight };
    }
    if (op === "engage") {
      const mount = getMount();
      if (mount === undefined) {
        return { error: "the pencil surface was not injected" };
      }
      handle ??= mount();
      handle.engage(Number(payload.fadeSec ?? 0));
      return { ok: true };
    }
    if (handle === undefined) {
      return { ok: true }; // nothing mounted yet — a stray op after disengage
    }
    switch (op) {
      case "disengage":
        // Keep the handle (and its strokes) — disengage only stops owning the
        // pointer; re-engage reuses the same surface, so markup survives turns.
        handle.disengage();
        return { ok: true };
      case "fade":
        handle.setFade(Number(payload.fadeSec ?? 0));
        return { ok: true };
      case "clear":
        handle.clear();
        return { ok: true };
      case "undo":
        handle.undo();
        return { ok: true };
      case "rbegin":
        handle.remoteBegin(
          String(payload.id),
          payload.init as Parameters<PencilHandle["remoteBegin"]>[1],
        );
        return { ok: true };
      case "rpoint":
        handle.remotePoint(
          String(payload.id),
          payload.point as Parameters<PencilHandle["remotePoint"]>[1],
        );
        return { ok: true };
      case "rend":
        handle.remoteEnd(
          String(payload.id),
          payload.point as Parameters<PencilHandle["remoteEnd"]>[1],
        );
        return { ok: true };
      case "rcancel":
        handle.remoteCancel(String(payload.id));
        return { ok: true };
      default:
        return { error: `unknown pencil op: ${op}` };
    }
  };
}
