// @vitest-environment jsdom
/**
 * pencil-mount.test.ts — the in-page surface's ROUTING and lifecycle: the pen
 * is captured (and kept from the page), mouse/touch fall through, and engage /
 * disengage mount and tear down. The stroke COMMIT (bake to a 2D context) needs
 * a real canvas — jsdom has none — so that path is the real-browser
 * verification, not here; these rows pin what is testable without pixels.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mountPencil } from "./pencil-mount";

const HOST = "__aiui-intent-pencil";

function pen(type: string, id: number, x = 5, y = 5): PointerEvent {
  return new PointerEvent(type, {
    pointerId: id,
    pointerType: "pen",
    clientX: x,
    clientY: y,
    bubbles: true,
    cancelable: true,
  });
}

afterEach(() => {
  document.getElementById(HOST)?.remove();
  document.body.innerHTML = "";
});

describe("mountPencil", () => {
  it("engage mounts the host; disengage tears it down", () => {
    const h = mountPencil();
    expect(document.getElementById(HOST)).toBeNull();
    h.engage(0);
    expect(document.getElementById(HOST)).not.toBeNull();
    h.disengage();
    expect(document.getElementById(HOST)).toBeNull();
  });

  it("captures the pen and keeps it from the page; mouse falls through", () => {
    const h = mountPencil();
    h.engage(0);

    const down = pen("pointerdown", 1);
    document.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true); // ours — the page never sees it

    const move = pen("pointermove", 1, 9, 9);
    document.dispatchEvent(move);
    expect(move.defaultPrevented).toBe(true);

    // A mouse is not a pencil — it passes straight through to the page.
    const mouse = new PointerEvent("pointerdown", {
      pointerId: 2,
      pointerType: "mouse",
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(mouse);
    expect(mouse.defaultPrevented).toBe(false);

    h.disengage();
  });

  it("after disengage the pen listener is gone — the page owns the pen again", () => {
    const h = mountPencil();
    h.engage(0);
    h.disengage();
    const down = pen("pointerdown", 3);
    document.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(false);
  });

  it("size falls back to the viewport before the surface reports one", () => {
    const h = mountPencil();
    // Not engaged: no surface yet — the host still answers with the viewport.
    expect(h.size()).toEqual({ width: window.innerWidth, height: window.innerHeight });
  });
});
