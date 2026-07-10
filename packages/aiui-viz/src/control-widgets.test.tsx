// @vitest-environment jsdom
/**
 * control-widgets.test.tsx — the two earned widgets: bounds from meta, writes
 * through the control's validation, attribution stamps on the label.
 */
import { render } from "@solidjs/web";
import { afterEach, describe, expect, it } from "vitest";
import { clearControlSurface, control } from "./control";
import { ControlSlider, ControlToggle } from "./control-widgets";
import { tick } from "./testing";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  hardResetControlSurface();
});

function mount(el: () => unknown): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  dispose = render(el as never, host);
  return host;
}

import { disposeDurable } from "./durable";
import { resetDependencyEdges } from "./graph-trace";

/** Library-internal hard reset: these tests declare FRESH controls per case. */
function hardResetControlSurface(): void {
  const { durableKeys } = clearControlSurface();
  for (const key of durableKeys) {
    disposeDurable(key);
  }
  resetDependencyEdges();
}

describe("ControlSlider", () => {
  it("renders bounds/step from the control's meta and stamps attribution", () => {
    const kappa = control({
      name: "kappa",
      value: 0.1,
      description: "Diffusion constant",
      min: 0.01,
      max: 1,
      step: 0.01,
    });
    const host = mount(() => <ControlSlider of={kappa} label="diffusion" />);

    const input = host.querySelector("input") as HTMLInputElement;
    expect(input.min).toBe("0.01");
    expect(input.max).toBe("1");
    expect(input.step).toBe("0.01");
    expect(input.value).toBe("0.1");

    const label = host.querySelector("label") as HTMLElement;
    expect(label.dataset.control).toBe("kappa"); // the data-control stamp
    expect(label.title).toBe("Diffusion constant"); // description → tooltip
    expect(label.textContent).toContain("diffusion");
  });

  it("writes go through the control's own validation (clamp), and the readout follows", async () => {
    const steps = control({ name: "steps", value: 100, min: 1, max: 200, unit: " steps" });
    const host = mount(() => <ControlSlider of={steps} />);
    const input = host.querySelector("input") as HTMLInputElement;

    input.value = "5000"; // beyond max — a hostile/mis-scripted input event
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();

    expect(steps.get()).toBe(200); // clamped by the control, not the widget
    expect(host.querySelector("b")?.textContent).toBe("200 steps"); // unit riding along
  });

  it("honors a custom format", () => {
    const speed = control({ name: "speed", value: 0, min: 0, max: 48 });
    const host = mount(() => (
      <ControlSlider of={speed} format={(v) => (v === 0 ? "paused" : `${v}/frame`)} />
    ));
    expect(host.querySelector("b")?.textContent).toBe("paused");
  });
});

describe("ControlToggle", () => {
  it("two-way binds a boolean control with the stamp and title", async () => {
    const auto = control({ name: "autoAnalyze", value: true, description: "Re-run on a cadence" });
    const host = mount(() => <ControlToggle of={auto} label="auto" />);

    const label = host.querySelector("label") as HTMLElement;
    expect(label.dataset.control).toBe("autoAnalyze");
    expect(label.title).toBe("Re-run on a cadence");

    const input = host.querySelector("input") as HTMLInputElement;
    expect(input.checked).toBe(true);
    input.checked = false;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    expect(auto.get()).toBe(false);
  });
});
