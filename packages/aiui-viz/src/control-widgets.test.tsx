// @vitest-environment jsdom
/**
 * control-widgets.test.tsx — the earned widgets: bounds/options from meta,
 * writes through the control's validation, attribution stamps on the root.
 */
import { render } from "@solidjs/web";
import { afterEach, describe, expect, it } from "vitest";
import { clearControlSurface, control } from "./control";
import { ControlScrub, ControlSelect, ControlSlider, ControlToggle } from "./control-widgets";
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

/** jsdom has no PointerEvent; a bubbling MouseEvent of the right type walks
 * the same delegated path (the widget's capture call is `?.`-guarded). */
function pointer(el: Element, type: string, clientX: number): void {
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX, button: 0 }));
}

describe("ControlScrub", () => {
  it("drags horizontally: range/300 per px, snapped and clamped by the control", async () => {
    const salary = control({
      name: "salary",
      value: 350_000,
      min: 100_000,
      max: 700_000,
      step: 10_000,
      description: "Annual salary",
    });
    const host = mount(() => (
      <ControlScrub of={salary} label="salary" format={(v) => `$${v / 1000}k`} />
    ));
    const pill = host.querySelector(".scrub") as HTMLElement;
    expect(pill.dataset.control).toBe("salary");
    expect(pill.title).toBe("Annual salary");
    expect(pill.querySelector(".scrub-label")?.textContent).toBe("salary");
    expect(pill.querySelector(".scrub-value")?.textContent).toBe("$350k");

    // 50px right at (700k − 100k)/300 = $2k/px → +$100k, snapped to $10k.
    pointer(pill, "pointerdown", 0);
    pointer(pill, "pointermove", 50);
    await tick();
    expect(salary.get()).toBe(450_000);
    expect(pill.classList.contains("is-scrubbing")).toBe(true);
    expect(pill.textContent).toContain("$450k");

    // A huge drag clamps at the declared max.
    pointer(pill, "pointermove", 10_000);
    await tick();
    expect(salary.get()).toBe(700_000);

    // Release ends the gesture: further moves change nothing.
    pointer(pill, "pointerup", 10_000);
    pointer(pill, "pointermove", -10_000);
    await tick();
    expect(salary.get()).toBe(700_000);
    expect(pill.classList.contains("is-scrubbing")).toBe(false);
  });

  it("log mode drags in decades: equal pixels, equal factor", async () => {
    const rho = control({ name: "rho", value: 0.001, min: 0.0001, max: 1 });
    const host = mount(() => <ControlScrub of={rho} log format={(v) => v.toExponential(0)} />);
    const pill = host.querySelector(".scrub") as HTMLElement;
    expect(pill.querySelector(".scrub-label")).toBeNull(); // no label, no caption span

    // ρ spans 10⁻⁴…1 → 4 decades over 300px, so +75px is exactly ×10.
    pointer(pill, "pointerdown", 0);
    pointer(pill, "pointermove", 75);
    await tick();
    expect(rho.get()).toBeCloseTo(0.01, 10);

    // A huge left drag clamps at the declared min, not zero or negative.
    pointer(pill, "pointermove", -10_000);
    await tick();
    expect(rho.get()).toBeCloseTo(0.0001, 10);
    pointer(pill, "pointerup", -10_000);
  });

  it("span sets the drag length; the default readout carries the unit; ref sees the pill", async () => {
    const gain = control({ name: "gain", value: 0, min: 0, max: 100, unit: " dB" });
    let seen: HTMLElement | undefined;
    const host = mount(() => (
      <ControlScrub
        of={gain}
        span={100}
        ref={(el) => {
          seen = el;
        }}
      />
    ));
    const pill = host.querySelector(".scrub") as HTMLElement;
    expect(seen).toBe(pill);
    expect(pill.querySelector(".scrub-value")?.textContent).toBe("0 dB");
    pointer(pill, "pointerdown", 0);
    pointer(pill, "pointermove", 25); // a quarter of the span → a quarter of the range
    await tick();
    expect(gain.get()).toBe(25);
    pointer(pill, "pointerup", 25);
  });
});

describe("ControlSelect", () => {
  it("lists the declared options, follows the control, and writes the chosen option", async () => {
    const style = control({
      name: "style",
      value: "ieee" as "ieee" | "iec",
      options: ["ieee", "iec"] as const,
      description: "Symbol convention",
    });
    const host = mount(() => (
      <ControlSelect of={style} label="convention" labels={{ ieee: "IEEE (US)", iec: "IEC" }} />
    ));
    const label = host.querySelector("label") as HTMLElement;
    expect(label.classList.contains("select")).toBe(true);
    expect(label.dataset.control).toBe("style");
    expect(label.title).toBe("Symbol convention");
    expect(label.querySelector(".slider-label")?.textContent).toBe("convention");

    const select = host.querySelector("select") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(["IEEE (US)", "IEC"]);
    expect(select.value).toBe("ieee");

    select.selectedIndex = 1;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    expect(style.get()).toBe("iec");

    style.set("ieee");
    await tick();
    expect(select.value).toBe("ieee"); // the widget follows an outside write
  });

  it("writes the declared option, not the option's string (numeric enums)", async () => {
    const bits = control({ name: "bits", value: 8, options: [8, 16, 32] });
    const host = mount(() => <ControlSelect of={bits} labels={(b) => `${b}-bit`} />);
    const select = host.querySelector("select") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      "8-bit",
      "16-bit",
      "32-bit",
    ]);
    select.selectedIndex = 2;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    expect(bits.get()).toBe(32);
    expect(typeof bits.get()).toBe("number");
  });
});
