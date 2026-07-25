// @vitest-environment jsdom
/**
 * pen-input.test.ts — the two-finger navigation path (found dropped live
 * 2026-07-25: zero scroll intents on the wire while the user panned). Pins
 * that a two-finger drift emits scroll intents even after pen mode latched —
 * the exact state an iPad is in when the user pans mid-markup.
 */
import { describe, expect, it } from "vitest";
import type { PencilParams } from "../pencil";
import { bindPenInput, type PenSink } from "./pen-input";
import type { PlaneTracker } from "./plane";

function fakeSink(): { sink: PenSink; calls: string[] } {
  const calls: string[] = [];
  const sink: PenSink = {
    begin: (id) => calls.push(`begin:${id}`),
    points: () => calls.push("points"),
    end: (id) => calls.push(`end:${id}`),
    cancel: (id) => calls.push(`cancel:${id}`),
    scroll: (du, dv) => calls.push(`scroll:${du.toFixed(2)},${dv.toFixed(2)}`),
    zoom: () => calls.push("zoom"),
  };
  return { sink, calls };
}

const plane: PlaneTracker = {
  box: () => ({ left: 0, top: 0, width: 100, height: 100 }),
  recompute: () => {},
};

function pe(type: string, pointerType: string, id: number, x: number, y: number): PointerEvent {
  return new PointerEvent(type, {
    pointerId: id,
    pointerType,
    button: 0,
    clientX: x,
    clientY: y,
    bubbles: true,
    cancelable: true,
  });
}

describe("two-finger navigation", () => {
  it("emits scroll intents for a two-finger drift — even after pen mode latched", () => {
    const el = document.createElement("div");
    document.body.append(el);
    const { sink, calls } = fakeSink();
    bindPenInput(el, {
      plane,
      sink,
      preview: () => undefined,
      tool: () => "draw",
      params: () => ({}) as PencilParams,
      navigation: () => true,
    });

    // Latch pen mode first — the real iPad state when the user pans.
    el.dispatchEvent(pe("pointerdown", "pen", 9, 10, 10));
    el.dispatchEvent(pe("pointerup", "pen", 9, 20, 20));
    calls.length = 0;

    el.dispatchEvent(pe("pointerdown", "touch", 1, 40, 40));
    el.dispatchEvent(pe("pointerdown", "touch", 2, 60, 40));
    el.dispatchEvent(pe("pointermove", "touch", 1, 40, 30));
    el.dispatchEvent(pe("pointermove", "touch", 2, 60, 30));
    expect(calls.some((c) => c.startsWith("scroll:"))).toBe(true);
    el.remove();
  });

  it("stays inert when the presentation turned navigation off", () => {
    const el = document.createElement("div");
    document.body.append(el);
    const { sink, calls } = fakeSink();
    bindPenInput(el, {
      plane,
      sink,
      preview: () => undefined,
      tool: () => "draw",
      params: () => ({}) as PencilParams,
      navigation: () => false,
    });
    el.dispatchEvent(pe("pointerdown", "touch", 1, 40, 40));
    el.dispatchEvent(pe("pointerdown", "touch", 2, 60, 40));
    el.dispatchEvent(pe("pointermove", "touch", 1, 40, 30));
    expect(calls.filter((c) => c.startsWith("scroll:") || c === "zoom")).toEqual([]);
    el.remove();
  });
});
