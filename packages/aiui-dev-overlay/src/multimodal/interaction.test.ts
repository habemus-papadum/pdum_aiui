// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { type InteractionMonitor, watchInteraction } from "./interaction";

let monitor: InteractionMonitor | undefined;
afterEach(() => {
  monitor?.dispose();
  monitor = undefined;
});

const watch = (): InteractionMonitor => {
  monitor = watchInteraction(window);
  return monitor;
};

describe("watchInteraction", () => {
  it("starts clean", () => {
    expect(watch().pending()).toBe(false);
  });

  it.each(["pointerdown", "pointerup", "keydown", "wheel"])("counts %s", (type) => {
    const m = watch();
    window.dispatchEvent(new Event(type, { bubbles: true }));
    expect(m.consume()).toBe(true);
  });

  it("IGNORES a bare pointermove — a nudged mouse changed nothing on screen", () => {
    const m = watch();
    window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, buttons: 0 }));
    expect(m.pending()).toBe(false);
  });

  it("counts a pointermove with a button held — a slider drag, a stroke", () => {
    const m = watch();
    window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, buttons: 1 }));
    expect(m.consume()).toBe(true);
  });

  it("consume() reads and clears; the next tick sees nothing new", () => {
    const m = watch();
    window.dispatchEvent(new Event("keydown", { bubbles: true }));
    expect(m.consume()).toBe(true);
    expect(m.consume()).toBe(false);
    expect(m.pending()).toBe(false);
  });

  it("note() arms it for sources with no DOM event (the iPad's pencil)", () => {
    const m = watch();
    m.note();
    expect(m.consume()).toBe(true);
  });

  it("sees input the app stops propagating — the listener is capture-phase", () => {
    const m = watch();
    const target = document.createElement("div");
    document.body.append(target);
    target.addEventListener("pointerdown", (e) => e.stopPropagation());
    target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(m.consume()).toBe(true);
    target.remove();
  });

  it("dispose() stops watching", () => {
    const m = watch();
    m.dispose();
    window.dispatchEvent(new Event("keydown", { bubbles: true }));
    expect(m.pending()).toBe(false);
  });
});
