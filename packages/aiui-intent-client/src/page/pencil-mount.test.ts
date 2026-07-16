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
import { afterEach, describe, expect, it } from "vitest";
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
