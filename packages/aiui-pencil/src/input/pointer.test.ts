// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindPenInput, type PenInputBinding, type PenInputOptions } from "./pointer";

const bindings: PenInputBinding[] = [];
afterEach(() => {
  for (const binding of bindings.splice(0)) binding.dispose();
  document.body.replaceChildren();
});

function setup(options: Partial<PenInputOptions> = {}) {
  const element = document.createElement("div");
  document.body.append(element);
  const sink = { begin: vi.fn(), points: vi.fn(), end: vi.fn(), cancel: vi.fn() };
  const onPan = vi.fn();
  const onZoom = vi.fn();
  const clock = { time: 1000 };
  const binding = bindPenInput(element, {
    bounds: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    sink,
    onPan,
    onZoom,
    now: () => clock.time,
    ...options,
  });
  bindings.push(binding);
  const send = (type: string, kind: string, id: number, x = 10, y = 10, contact = 1) => {
    const event = new PointerEvent(type, {
      pointerId: id,
      pointerType: kind,
      button: 0,
      clientX: x,
      clientY: y,
      width: contact,
      height: contact,
      bubbles: true,
      cancelable: true,
    });
    element.dispatchEvent(event);
    return event;
  };
  return { element, sink, onPan, onZoom, binding, send, clock };
}

describe("local input policy", () => {
  it("rejects palms, lets a pencil supersede a finger, then stops fingers inking", () => {
    const { send, sink, binding } = setup();
    send("pointerdown", "touch", 1, 10, 10, 66);
    expect(sink.begin).not.toHaveBeenCalled();
    send("pointerup", "touch", 1);
    send("pointerdown", "touch", 2);
    const finger = sink.begin.mock.calls[0][0];
    send("pointerdown", "pen", 3);
    expect(sink.cancel).toHaveBeenCalledWith(finger);
    expect(sink.begin).toHaveBeenCalledTimes(2);
    send("pointerdown", "touch", 4);
    send("pointermove", "touch", 4, 40, 40);
    expect(sink.cancel).toHaveBeenCalledTimes(1);
    send("pointerup", "pen", 3);
    expect(sink.end).toHaveBeenCalledTimes(1);
    send("pointerup", "touch", 2);
    send("pointerup", "touch", 4);
    send("pointerdown", "touch", 5);
    expect(sink.begin).toHaveBeenCalledTimes(2);
    expect(binding.counts().palms).toBe(1);
  });

  it("cancels the first finger's ink when it becomes a two-finger gesture", () => {
    const { send, sink, onPan, onZoom } = setup();
    send("pointerdown", "touch", 1, 40, 40);
    send("pointerdown", "touch", 2, 60, 40);
    expect(sink.cancel).toHaveBeenCalledTimes(1);
    send("pointermove", "touch", 2, 80, 40);
    expect(onZoom).toHaveBeenCalledWith(0.6, 0.4, 2);
    expect(onPan.mock.calls[0][0]).toBeCloseTo(-0.1);
    expect(onPan.mock.calls[0][1]).toBeCloseTo(0);
    send("pointerup", "touch", 1);
    send("pointerup", "touch", 2);
    expect(sink.end).not.toHaveBeenCalled();
  });

  it("navigates with palm-sized finger contacts after pen mode latches", () => {
    const { send, onPan, sink, clock } = setup();
    send("pointerdown", "pen", 9);
    send("pointerup", "pen", 9);
    clock.time += 501;
    send("pointerdown", "touch", 1, 40, 40, 66);
    send("pointerdown", "touch", 2, 60, 40, 66);
    send("pointermove", "touch", 1, 40, 30, 66);
    send("pointermove", "touch", 2, 60, 30, 66);
    expect(onPan).toHaveBeenCalled();
    expect(sink.begin).toHaveBeenCalledTimes(1);
  });

  it("suppresses navigation while writing and during its cooldown", () => {
    const { send, onPan, onZoom, clock } = setup();
    send("pointerdown", "pen", 9);
    send("pointerdown", "touch", 1, 40, 40, 66);
    send("pointerdown", "touch", 2, 60, 40, 66);
    send("pointermove", "touch", 1, 40, 30, 66);
    send("pointerup", "pen", 9);
    send("pointermove", "touch", 2, 60, 30, 66);
    expect(onPan).not.toHaveBeenCalled();
    expect(onZoom).not.toHaveBeenCalled();
    clock.time += 501;
    send("pointermove", "touch", 1, 40, 20, 66);
    expect(onPan.mock.calls[0][0]).toBeCloseTo(0);
    expect(onPan.mock.calls[0][1]).toBeCloseTo(0.05);
  });

  it("lets the application disable navigation", () => {
    const { send, onPan, onZoom } = setup({ navigation: () => false });
    send("pointerdown", "touch", 1, 40, 40);
    send("pointerdown", "touch", 2, 60, 40);
    send("pointermove", "touch", 1, 20, 30);
    expect(onPan).not.toHaveBeenCalled();
    expect(onZoom).not.toHaveBeenCalled();
  });

  it("maps inset coordinates and forwards all coalesced samples", () => {
    const { send, sink, element } = setup({
      bounds: () => ({ left: 5, top: 7, width: 100, height: 100 }),
    });
    send("pointerdown", "pen", 1, 15, 17);
    expect(sink.begin.mock.calls[0][1]).toMatchObject({ x: 10, y: 10 });
    const move = new PointerEvent("pointermove", { pointerId: 1, pointerType: "pen" });
    Object.defineProperty(move, "getCoalescedEvents", {
      value: () => [
        new PointerEvent("pointermove", { clientX: 20, clientY: 30, pressure: 0.4 }),
        new PointerEvent("pointermove", { clientX: 30, clientY: 40, pressure: 0.8 }),
      ],
    });
    element.dispatchEvent(move);
    expect(sink.points.mock.calls[0][1]).toMatchObject([
      { x: 15, y: 23 },
      { x: 25, y: 33 },
    ]);
    expect(sink.points.mock.calls[0][1][0].pressure).toBeCloseTo(0.4);
    expect(sink.points.mock.calls[0][1][1].pressure).toBeCloseTo(0.8);
  });

  it.each(["pointercancel", "lostpointercapture"])("%s cancels rather than commits", (event) => {
    const { send, sink } = setup();
    send("pointerdown", "pen", 1);
    send(event, "pen", 1);
    expect(sink.cancel).toHaveBeenCalledTimes(1);
    expect(sink.end).not.toHaveBeenCalled();
  });

  it("detaches on disposal, cancels once, and supports rebinding", () => {
    const { send, sink, element, binding } = setup();
    send("pointerdown", "pen", 1);
    binding.dispose();
    binding.dispose();
    send("pointerup", "pen", 1);
    send("pointerdown", "pen", 2);
    expect(sink.cancel).toHaveBeenCalledTimes(1);
    expect(sink.begin).toHaveBeenCalledTimes(1);
    expect(binding.penDown()).toBe(false);
    bindings.push(bindPenInput(element, { sink }));
    send("pointerdown", "pen", 3);
    expect(sink.begin).toHaveBeenCalledTimes(2);
  });

  it("cancels active input on window blur", () => {
    const { send, sink, binding } = setup();
    send("pointerdown", "pen", 1);
    window.dispatchEvent(new Event("blur"));
    expect(sink.cancel).toHaveBeenCalledTimes(1);
    expect(binding.penDown()).toBe(false);
  });

  it("respects vetoes, ignored controls, and non-primary mouse buttons", () => {
    const veto = setup({ shouldCapture: () => false });
    veto.send("pointerdown", "pen", 1);
    expect(veto.sink.begin).not.toHaveBeenCalled();
    const { element, sink } = setup();
    const button = document.createElement("button");
    button.dataset.pencilInputIgnore = "";
    element.append(button);
    button.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "pen", bubbles: true }));
    element.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "mouse", button: 2 }));
    expect(sink.begin).not.toHaveBeenCalled();
  });

  it("only prevents Safari stylus touches, preserving finger navigation", () => {
    const { element } = setup();
    const touch = (touchType: string) => {
      const event = new Event("touchstart", { cancelable: true });
      Object.defineProperty(event, "changedTouches", { value: [{ touchType }] });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(touch("stylus")).toBe(true);
    expect(touch("direct")).toBe(false);
  });
});
