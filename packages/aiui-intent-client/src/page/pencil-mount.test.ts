// @vitest-environment jsdom
/**
 * pencil-mount.test.ts — the in-page surface's WIRING and lifecycle, now mirror
 * of ink's: native input (mouse AND pen, not pen-only), `setActive` owns/releases
 * the pointer, and strokes SURVIVE disengage (the surface is not torn down until
 * a real dispose). The stroke COMMIT (bake to a 2D context) needs a real canvas —
 * jsdom has none — so pointer-UP is the real-browser verification; these rows pin
 * everything testable without pixels, including that a pointer-DOWN begins a live
 * stroke for both devices (which the old pen-only shim refused the mouse).
 */
import { PencilSurface } from "@habemus-papadum/aiui-pencil";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountPencil } from "./pencil-mount";

const HOST = "__aiui-intent-pencil";

const canvas = (): HTMLCanvasElement | null =>
  document.getElementById(HOST)?.querySelector("canvas") ?? null;

function down(pointerType: "pen" | "mouse" | "touch", id: number): PointerEvent {
  return new PointerEvent("pointerdown", {
    pointerId: id,
    pointerType,
    button: 0,
    clientX: 5,
    clientY: 5,
    bubbles: true,
    cancelable: true,
  });
}

afterEach(() => {
  document.getElementById(HOST)?.remove();
  document.body.innerHTML = "";
});

describe("mountPencil", () => {
  it("engage mounts the host and gives the surface the pointer (setActive works — localInput is on)", () => {
    const h = mountPencil();
    expect(document.getElementById(HOST)).toBeNull();
    h.engage(0);
    expect(document.getElementById(HOST)).not.toBeNull();
    // pointer-events flips to auto ONLY when localInput !== false — the exact
    // regression: the old mount passed localInput:false, making setActive a no-op.
    expect(canvas()?.style.pointerEvents).toBe("auto");
  });

  it("disengage KEEPS the surface (strokes survive) and just releases the pointer", () => {
    const h = mountPencil();
    h.engage(0);
    const before = document.getElementById(HOST);
    h.disengage();
    // The host is STILL mounted — disengage is setActive(false), not teardown.
    expect(document.getElementById(HOST)).toBe(before);
    expect(canvas()?.style.pointerEvents).toBe("none"); // page owns the pointer again
  });

  it("re-engage reuses the same surface across turns (markup persists)", () => {
    const h = mountPencil();
    h.engage(0);
    const first = document.getElementById(HOST);
    h.disengage();
    h.engage(0);
    expect(document.getElementById(HOST)).toBe(first); // same element, same strokes
    expect(canvas()?.style.pointerEvents).toBe("auto");
  });

  it("dispose tears the host down (page unload / hard clean)", () => {
    const h = mountPencil();
    h.engage(0);
    h.dispose();
    expect(document.getElementById(HOST)).toBeNull();
  });

  it("takes native input from BOTH mouse and pen (the old shim refused the mouse)", () => {
    for (const device of ["mouse", "pen", "touch"] as const) {
      const h = mountPencil();
      h.engage(0);
      expect(h.hasInk()).toBe(false);
      canvas()?.dispatchEvent(down(device, 1));
      // A pointer-down began a live stroke — for the mouse too, which the
      // pen-only shim would have dropped. (Commit/bake is real-browser only.)
      expect(h.hasInk()).toBe(true);
      h.dispose();
    }
  });

  it("size falls back to the viewport before the surface reports one", () => {
    const h = mountPencil();
    expect(h.size()).toEqual({ width: window.innerWidth, height: window.innerHeight });
  });
});

describe("document anchoring (best-effort, the ink-era §13.6 contract)", () => {
  const setScroll = (x: number, y: number): void => {
    Object.defineProperty(window, "scrollX", { value: x, configurable: true });
    Object.defineProperty(window, "scrollY", { value: y, configurable: true });
    window.dispatchEvent(new Event("scroll"));
  };
  const setViewport = (w: number, h: number): void => {
    Object.defineProperty(window, "innerWidth", { value: w, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: h, configurable: true });
    window.dispatchEvent(new Event("resize"));
  };
  const host = (): HTMLElement | null => document.getElementById(HOST);
  const BASE = { w: window.innerWidth, h: window.innerHeight };

  afterEach(() => {
    setScroll(0, 0);
    Object.defineProperty(window, "innerWidth", { value: BASE.w, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: BASE.h, configurable: true });
  });

  it("an INKED surface glues to the content: the host translates by the scroll delta", () => {
    const h = mountPencil();
    h.engage(0);
    h.remoteBegin("r1", {
      tool: "draw",
      params: { color: "#e5484d" } as never,
      point: { x: 10, y: 10 } as never,
    });
    setScroll(0, 100);
    expect(host()?.style.transform).toBe("translate(0px, -100px)");
    setScroll(30, 100);
    expect(host()?.style.transform).toBe("translate(-30px, -100px)");
    h.dispose();
  });

  it("an EMPTY surface rebases instead — drawing works wherever you scrolled to", () => {
    const h = mountPencil();
    h.engage(0);
    setScroll(0, 500);
    expect(host()?.style.transform).toBe("");
    // Ink drawn AFTER the rebase anchors at the new scroll; a further scroll
    // translates relative to the rebase, not the mount.
    h.remoteBegin("r1", { tool: "draw", params: {} as never, point: { x: 1, y: 1 } as never });
    setScroll(0, 540);
    expect(host()?.style.transform).toBe("translate(0px, -40px)");
    h.dispose();
  });

  it("scroll DISTANCE alone never retires — glued ink survives any round trip", () => {
    // The first cut retired at 0.6·viewport, which read as "my ink vanished
    // when I scrolled it off screen" (owner, 2026-07-17). Ink now rides the
    // transform indefinitely and comes back.
    const h = mountPencil();
    h.engage(0);
    h.remoteBegin("r1", { tool: "draw", params: {} as never, point: { x: 1, y: 1 } as never });
    const clearSpy = vi.spyOn(PencilSurface.prototype, "clearAnimated");
    setScroll(0, 3000); // several viewports away
    expect(host()?.style.transform).toBe("translate(0px, -3000px)");
    setScroll(0, 0); // …and back: still glued, still there
    expect(host()?.style.transform).toBe("");
    expect(h.hasInk()).toBe(true);
    expect(clearSpy).not.toHaveBeenCalled();
    clearSpy.mockRestore();
    h.dispose();
  });

  it("a NEW stroke outside the anchored coverage REBASES — nothing is cleared", () => {
    const h = mountPencil();
    h.engage(0);
    h.remoteBegin("r1", { tool: "draw", params: {} as never, point: { x: 1, y: 1 } as never });
    setScroll(0, 2000);
    // A remote stroke begun at frame y=50 maps to canvas y=2050 — outside the
    // backing. The overlay rebases (translate re-bakes; the old ink keeps its
    // points, off-canvas) so the stroke lands on paper. NEVER a clear.
    const translate = vi.spyOn(PencilSurface.prototype, "translate");
    const hardClear = vi.spyOn(PencilSurface.prototype, "clear");
    h.remoteBegin("r2", { tool: "draw", params: {} as never, point: { x: 5, y: 50 } as never });
    expect(translate).toHaveBeenCalledWith(0, -2000);
    expect(hardClear).not.toHaveBeenCalled();
    expect(host()?.style.transform).toBe("");
    expect(h.hasInk()).toBe(true);
    translate.mockRestore();
    hardClear.mockRestore();
    h.dispose();
  });

  it("scroll REST rebases (debounced): the glide transform resets, the ink re-bakes", () => {
    vi.useFakeTimers();
    try {
      const h = mountPencil();
      h.engage(0);
      h.remoteBegin("r1", { tool: "draw", params: {} as never, point: { x: 1, y: 1 } as never });
      const translate = vi.spyOn(PencilSurface.prototype, "translate");
      setScroll(0, 300);
      expect(host()?.style.transform).toBe("translate(0px, -300px)"); // gliding
      vi.advanceTimersByTime(200); // …the page came to rest
      expect(translate).toHaveBeenCalledWith(0, -300);
      expect(host()?.style.transform).toBe(""); // re-anchored HERE
      translate.mockRestore();
      h.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ANY resize (or zoom step) retires the markup — no thresholds", () => {
    const h = mountPencil();
    h.engage(0);
    h.remoteBegin("r1", { tool: "draw", params: {} as never, point: { x: 1, y: 1 } as never });
    const fade = vi.spyOn(PencilSurface.prototype, "clearAnimated");
    // The first cut had a 5% threshold: a slow drag-resize emits many small
    // deltas that each stayed under it, so retirement felt random (owner,
    // 2026-07-17). Now every real change retires.
    setViewport(window.innerWidth - 10, window.innerHeight);
    expect(fade).toHaveBeenCalledTimes(1);
    fade.mockRestore();
    h.dispose();
  });

  it("remote points are shifted into the anchored space (they arrive frame-relative)", () => {
    const h = mountPencil();
    h.engage(0);
    // Anchor at 0,0 (mount) — then the page scrolls with ink present.
    h.remoteBegin("seed", { tool: "draw", params: {} as never, point: { x: 0, y: 0 } as never });
    setScroll(0, 100);
    // A remote point at frame y=50 must be STORED at canvas y=150 — under the
    // translate(-100) it renders back at viewport y=50, where the iPad aimed.
    const spy = vi.spyOn(PencilSurface.prototype, "remotePoint");
    h.remotePoint("seed", { x: 5, y: 50 } as never);
    expect(spy).toHaveBeenCalledWith("seed", expect.objectContaining({ x: 5, y: 150 }));
    spy.mockRestore();
    h.dispose();
  });
});
