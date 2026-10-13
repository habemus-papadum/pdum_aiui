// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { guardPenControls } from "./controls";
import type { PenActivity } from "./pointer";

it("keeps a refused palm blocked through release, then allows deliberate taps", () => {
  let time = 1000;
  let down = true;
  const activity = { penDown: () => down, lastPenUp: () => 1000 } as PenActivity;
  const container = document.createElement("div");
  const button = document.createElement("button");
  container.append(button);
  const click = vi.fn();
  button.addEventListener("click", click);
  const dispose = guardPenControls(
    container,
    () => activity,
    () => time,
  );
  const pointer = (type: string, kind = "touch") => {
    const e = new PointerEvent(type, {
      pointerId: 1,
      pointerType: kind,
      bubbles: true,
      cancelable: true,
    });
    button.dispatchEvent(e);
    return e.defaultPrevented;
  };
  expect(pointer("pointerdown")).toBe(true);
  expect(pointer("pointerdown", "pen")).toBe(false);
  expect(pointer("pointerdown", "mouse")).toBe(false);
  down = false;
  time += 1000;
  expect(pointer("pointerup")).toBe(true);
  button.click();
  expect(click).not.toHaveBeenCalled();
  time += 81;
  expect(pointer("pointerdown")).toBe(false);
  button.click();
  expect(click).toHaveBeenCalledTimes(1);
  down = true;
  dispose();
  expect(pointer("pointerdown")).toBe(false);
});
