// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bindPenInput,
  type PenInputBinding,
  type PenInputOptions,
  type PenInputSamples,
} from "./pointer";

const bindings: PenInputBinding[] = [];
afterEach(() => {
  for (const binding of bindings.splice(0)) binding.dispose();
  document.body.replaceChildren();
});

function setup(options: Partial<PenInputOptions> = {}) {
  const element = document.createElement("div");
  document.body.append(element);
  const sink = { begin: vi.fn(), points: vi.fn(), end: vi.fn(), cancel: vi.fn() };
  const onNavigate = vi.fn();
  const clock = { time: 1000 };
  const binding = bindPenInput(element, {
    bounds: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    sink,
    onNavigate,
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
  return { element, sink, onNavigate, binding, send, clock };
}

describe("local input policy", () => {
  it("rejects palms, lets a pencil supersede a finger, then stops fingers inking", () => {
    const { send, sink, binding } = setup({ palmContactPx: 60 });
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
    const { send, sink, onNavigate, binding } = setup();
    send("pointerdown", "touch", 1, 40, 40);
    send("pointerdown", "touch", 2, 60, 40);
    expect(sink.cancel).toHaveBeenCalledTimes(1);
    const move = send("pointermove", "touch", 2, 80, 40);
    expect(onNavigate).toHaveBeenCalledWith({
      from: { x: 50, y: 40 },
      to: { x: 60, y: 40 },
      scale: 2,
      rotation: 0,
    });
    expect(move.defaultPrevented).toBe(true);
    expect(binding.counts()).toMatchObject({ scrolls: 1, zooms: 1, rotations: 0 });
    send("pointerup", "touch", 1);
    send("pointerup", "touch", 2);
    expect(sink.end).not.toHaveBeenCalled();
  });

  it("rejects contacts above an explicit size cutoff after pen mode latches", () => {
    const { send, onNavigate, sink } = setup({ palmContactPx: 60 });
    send("pointerdown", "pen", 9);
    send("pointerup", "pen", 9);
    send("pointerdown", "touch", 1, 40, 40, 66);
    send("pointerdown", "touch", 2, 60, 40, 66);
    send("pointermove", "touch", 1, 40, 30, 66);
    send("pointermove", "touch", 2, 60, 30, 66);
    expect(onNavigate).not.toHaveBeenCalled();
    expect(sink.begin).toHaveBeenCalledTimes(1);
    send("pointerdown", "touch", 3, 40, 40);
    send("pointerdown", "touch", 4, 60, 40);
    send("pointermove", "touch", 4, 80, 40);
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("suppresses navigation while writing and during its cooldown", () => {
    const { send, onNavigate, clock } = setup({ navCooldownMs: 500 });
    send("pointerdown", "pen", 9);
    send("pointerdown", "touch", 1, 40, 40);
    send("pointerdown", "touch", 2, 60, 40);
    send("pointermove", "touch", 1, 40, 30);
    send("pointerup", "pen", 9);
    send("pointermove", "touch", 2, 60, 30);
    expect(onNavigate).not.toHaveBeenCalled();
    send("pointerup", "touch", 1, 40, 30);
    send("pointerup", "touch", 2, 60, 30);
    send("pointerdown", "touch", 3, 40, 40);
    send("pointerdown", "touch", 4, 60, 40);
    send("pointermove", "touch", 4, 60, 30);
    expect(onNavigate).not.toHaveBeenCalled();
    clock.time += 501;
    send("pointermove", "touch", 3, 40, 30);
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate.mock.calls[0][0]).toMatchObject({
      from: { x: 50, y: 35 },
      to: { x: 50, y: 30 },
    });
  });

  it("lets the application disable navigation", () => {
    const { send, onNavigate } = setup({ navigation: () => false });
    send("pointerdown", "touch", 1, 40, 40);
    send("pointerdown", "touch", 2, 60, 40);
    send("pointermove", "touch", 1, 20, 30);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("delivers rotation and centroids in local CSS coordinates, independently of ink mapping", () => {
    const batches: PenInputSamples[] = [];
    const { send, onNavigate, binding } = setup({
      bounds: () => ({ left: 5, top: 7, width: 100, height: 100 }),
      clientToInk: (sample) => ({ ...sample, x: sample.x / 10, y: sample.y / 10 }),
      onSamples: (batch) => batches.push(batch),
    });
    send("pointerdown", "touch", 1, 40, 40);
    send("pointerdown", "touch", 2, 60, 40);
    send("pointermove", "touch", 2, 40, 60);
    expect(onNavigate).toHaveBeenCalledWith({
      from: { x: 45, y: 33 },
      to: { x: 35, y: 43 },
      scale: 1,
      rotation: Math.PI / 2,
    });
    expect(batches.at(-1)).toMatchObject({
      accepted: false,
      decision: { disposition: "navigation" },
    });
    expect(binding.counts()).toMatchObject({ scrolls: 1, zooms: 0, rotations: 1 });
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

  it("pointercancel cancels rather than commits", () => {
    const { send, sink } = setup();
    send("pointerdown", "pen", 1);
    send("pointercancel", "pen", 1);
    expect(sink.cancel).toHaveBeenCalledTimes(1);
    expect(sink.end).not.toHaveBeenCalled();
  });

  it("retains ink when capture is lost before pen-up, then commits exactly once", () => {
    const { send, sink, binding } = setup();
    send("pointerdown", "pen", 1);
    const id = sink.begin.mock.calls[0][0];
    send("pointermove", "pen", 1, 30, 40);
    send("lostpointercapture", "pen", 1, 50, 60);
    expect(sink.cancel).not.toHaveBeenCalled();
    expect(sink.end).not.toHaveBeenCalled();
    expect(binding.penDown()).toBe(true);
    send("pointerup", "pen", 1, 50, 60);
    send("lostpointercapture", "pen", 1, 50, 60);
    expect(sink.end).toHaveBeenCalledExactlyOnceWith(id, expect.objectContaining({ x: 50, y: 60 }));
    expect(binding.counts()).toMatchObject({ began: 1, ended: 1, cancelled: 0 });
    expect(binding.penDown()).toBe(false);
  });

  it("follows only its active contacts outside the element after capture loss", () => {
    const { send, sink, binding } = setup();
    const elsewhere = document.createElement("div");
    document.body.append(elsewhere);
    // Another surface can stop bubbling; the drawing binding still needs its pen-up.
    elsewhere.addEventListener("pointerup", (event) => event.stopPropagation());
    send("pointerdown", "pen", 1);
    send("pointermove", "pen", 1, 20, 30);
    send("lostpointercapture", "pen", 1);
    const outside = (type: string, pointerId = 1) =>
      elsewhere.dispatchEvent(
        new PointerEvent(type, {
          pointerId,
          pointerType: "pen",
          clientX: 110,
          clientY: 120,
          bubbles: true,
        }),
      );
    outside("pointermove", 2);
    outside("pointerup", 2);
    outside("pointermove");
    outside("pointerup");
    expect(sink.points).toHaveBeenCalledTimes(2);
    expect(sink.points.mock.calls[1][1][0]).toMatchObject({ x: 110, y: 120 });
    expect(sink.end).toHaveBeenCalledTimes(1);
    expect(sink.end.mock.calls[0][1]).toMatchObject({ x: 110, y: 120 });
    expect(sink.cancel).not.toHaveBeenCalled();
    expect(binding.penDown()).toBe(false);
    outside("pointermove");
    outside("pointerup");
    expect(sink.points).toHaveBeenCalledTimes(2);
    expect(sink.end).toHaveBeenCalledTimes(1);
  });

  it.each([
    "pointercancel",
    "blur",
    "disable",
    "dispose",
  ])("still cancels after capture loss on %s", (reason) => {
    const { send, sink, binding } = setup();
    send("pointerdown", "pen", 1);
    send("lostpointercapture", "pen", 1);
    expect(sink.cancel).not.toHaveBeenCalled();
    if (reason === "pointercancel")
      document.body.dispatchEvent(
        new PointerEvent("pointercancel", {
          pointerId: 1,
          pointerType: "pen",
          bubbles: true,
        }),
      );
    else if (reason === "blur") window.dispatchEvent(new Event("blur"));
    else if (reason === "disable") binding.setEnabled(false);
    else binding.dispose();
    send("pointerup", "pen", 1);
    expect(sink.cancel).toHaveBeenCalledTimes(1);
    expect(sink.end).not.toHaveBeenCalled();
    expect(binding.penDown()).toBe(false);
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

describe("explicit input ownership and observations", () => {
  it("requires explicit pen activation and cancels strokes when disabled", () => {
    const { send, binding, sink, element } = setup({ penMode: "explicit" });
    send("pointerdown", "pen", 1);
    expect(sink.begin).not.toHaveBeenCalled();
    binding.setPenEnabled(true);
    send("pointerdown", "pen", 2);
    expect(sink.begin).toHaveBeenCalledTimes(1);
    binding.setEnabled(false);
    expect(sink.cancel).toHaveBeenCalledTimes(1);
    expect(binding.penDown()).toBe(false);
    send("pointermove", "pen", 2);
    send("pointerup", "pen", 2);
    send("pointerdown", "mouse", 3);
    expect(sink.points).not.toHaveBeenCalled();
    expect(sink.end).not.toHaveBeenCalled();
    expect(sink.begin).toHaveBeenCalledTimes(1);
    const touch = new Event("touchstart", { cancelable: true });
    Object.defineProperty(touch, "changedTouches", { value: [{ touchType: "stylus" }] });
    element.dispatchEvent(touch);
    expect(touch.defaultPrevented).toBe(false);
    binding.setEnabled(true);
    send("pointerdown", "pen", 4);
    expect(sink.begin).toHaveBeenCalledTimes(2);
    binding.setPenEnabled(false);
    expect(sink.cancel).toHaveBeenCalledTimes(2);
    send("pointerdown", "pen", 5);
    expect(sink.begin).toHaveBeenCalledTimes(2);
  });

  it("lets applications choose finger drawing without changing pen priority", () => {
    const never = setup({ fingerDrawing: "never" });
    never.send("pointerdown", "touch", 1);
    expect(never.sink.begin).not.toHaveBeenCalled();
    const always = setup({ fingerDrawing: "always" });
    always.send("pointerdown", "pen", 1);
    always.send("pointerup", "pen", 1);
    always.send("pointerdown", "touch", 2);
    expect(always.sink.begin).toHaveBeenCalledTimes(2);
    always.send("pointerdown", "pen", 3);
    expect(always.sink.cancel).toHaveBeenCalledTimes(1);
    expect(always.sink.begin).toHaveBeenCalledTimes(3);
  });

  it("maps client coordinates through the application transform at every sample", () => {
    let offset = 100;
    const { send, sink } = setup({
      clientToInk: (sample) => ({ ...sample, x: (sample.x + offset) / 2, y: sample.y / 2 }),
    });
    send("pointerdown", "pen", 1, 10, 20);
    expect(sink.begin.mock.calls[0][1]).toMatchObject({ x: 55, y: 10 });
    offset = 200;
    send("pointermove", "pen", 1, 30, 40);
    expect(sink.points.mock.calls[0][1][0]).toMatchObject({ x: 115, y: 20 });
    send("pointerup", "pen", 1, 50, 60);
    expect(sink.end.mock.calls[0][1]).toMatchObject({ x: 125, y: 30 });
  });

  it("reports rejected input, coalesced accepted samples, and predictions separately", () => {
    const batches: PenInputSamples[] = [];
    const { send, element, sink, binding } = setup({
      palmContactPx: 60,
      onSamples: (batch) => batches.push(batch),
    });
    send("pointerdown", "touch", 8, 10, 10, 100);
    expect(batches[0]).toMatchObject({
      phase: "down",
      accepted: false,
      strokeId: null,
      decision: { disposition: "tracked", reason: "palm" },
    });
    send("pointerdown", "pen", 1);
    const id = sink.begin.mock.calls[0][0];
    const move = new PointerEvent("pointermove", { pointerId: 1, pointerType: "pen" });
    Object.defineProperty(move, "getCoalescedEvents", {
      value: () => [
        new PointerEvent("pointermove", { clientX: 20, clientY: 30 }),
        new PointerEvent("pointermove", { clientX: 25, clientY: 35 }),
      ],
    });
    Object.defineProperty(move, "getPredictedEvents", {
      value: () => [new PointerEvent("pointermove", { clientX: 40, clientY: 50 })],
    });
    element.dispatchEvent(move);
    expect(batches[2]).toMatchObject({
      phase: "move",
      accepted: true,
      strokeId: id,
      coalesced: 2,
      predicted: 1,
      support: { coalescedApi: true, predictedApi: true },
      samples: [
        { x: 20, y: 30, kind: "pen" },
        { x: 25, y: 35, kind: "pen" },
      ],
      predictedSamples: [{ x: 40, y: 50, kind: "pen" }],
    });
    expect(sink.points.mock.calls[0][1]).toHaveLength(2);
    send("pointerup", "pen", 1);
    expect(batches[3]).toMatchObject({ phase: "up", accepted: true, strokeId: id });
    expect(binding.counts()).toMatchObject({ observedSamples: 5, acceptedSamples: 4 });
  });
});

it("releases capture even when a cancellation subscriber throws", () => {
  const { element, send, binding } = setup({
    sink: {
      begin() {},
      points() {},
      end() {},
      cancel() {
        throw new Error("cancel observer");
      },
    },
  });
  const release = vi.fn();
  Object.defineProperty(element, "releasePointerCapture", { value: release });
  send("pointerdown", "pen", 1);
  expect(() => binding.setEnabled(false)).toThrow("cancel observer");
  expect(release).toHaveBeenCalledWith(1);
  expect(binding.penDown()).toBe(false);
  expect(binding.counts().cancelled).toBe(1);
});
