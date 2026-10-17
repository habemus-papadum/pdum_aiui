// @vitest-environment jsdom
/**
 * knob.test.tsx — the shared knob gesture over a plain host: the stamp and
 * its live ARIA, the drag (through the document, so a synthetic pointer with
 * no capture still ends it), the keys, the hot ladder behind the readout, a
 * consumer's own hit resolution, and a drag surviving its element's
 * replacement.
 */
import { render } from "@solidjs/web";
import { createEffect } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { control } from "../control";
import { resetControlSurface, tick } from "../testing";
import {
  createKnobs,
  formatKnob,
  KNOB_SPAN,
  KnobReadout,
  type Knobs,
  type KnobsOptions,
  knobPerPx,
  knobStep,
} from "./knob";

const PE = typeof PointerEvent === "function" ? PointerEvent : MouseEvent;

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  resetControlSurface();
});

interface Rig {
  knobs: Knobs;
  host: HTMLElement;
  a: HTMLElement;
  b: HTMLElement;
  inner: HTMLElement;
  root: HTMLElement;
}

/** A host with two spans (`b` wraps an inner element) and the readout. */
function rig(options?: KnobsOptions): Rig {
  const out = {} as Rig;
  function Rig() {
    const knobs = createKnobs(options);
    let host!: HTMLElement;
    createEffect(
      () => undefined,
      () => {
        knobs.attach(host);
        out.knobs = knobs;
        out.host = host;
        out.a = host.querySelector(".a") as HTMLElement;
        out.b = host.querySelector(".b") as HTMLElement;
        out.inner = host.querySelector(".inner") as HTMLElement;
      },
    );
    return (
      <div
        class="host"
        ref={(el) => {
          host = el;
        }}
      >
        <span class="a">a</span>
        <span class="b">
          <i class="inner">b</i>
        </span>
        <KnobReadout of={knobs} />
      </div>
    );
  }
  const root = document.createElement("div");
  document.body.append(root);
  dispose = render(() => <Rig />, root);
  out.root = root;
  return out;
}

const readout = (root: HTMLElement): HTMLElement | null => root.querySelector(".aiui-knob-readout");

describe("the pure helpers", () => {
  it("formats at the step's precision and appends the unit", () => {
    expect(formatKnob(0.2, { step: 0.05 })).toBe("0.20");
    expect(formatKnob(0.2, { step: 0.001, unit: "/s" })).toBe("0.200/s");
    expect(formatKnob(12, { step: 1, unit: "km" })).toBe("12 km");
    expect(formatKnob(0.123456, {})).toBe("0.123456");
  });
  it("crosses the declared range over the span, else moves by the step", () => {
    const ranged = control({ name: "knob-pp-a", value: 0, min: 0, max: 1 });
    expect(knobPerPx(ranged, undefined)).toBeCloseTo(1 / KNOB_SPAN, 12);
    expect(knobPerPx(ranged, 100)).toBeCloseTo(0.01, 12);
    const stepped = control({ name: "knob-pp-b", value: 0, step: 0.5 });
    expect(knobPerPx(stepped, undefined)).toBe(0.5);
    expect(knobPerPx(control({ name: "knob-pp-c", value: 0 }), undefined)).toBe(1);
  });
  it("steps by the step, else a hundredth of the range, else 1", () => {
    expect(knobStep(control({ name: "knob-st-a", value: 0, step: 0.25 }))).toBe(0.25);
    expect(knobStep(control({ name: "knob-st-b", value: 0, min: 0, max: 50 }))).toBe(0.5);
    expect(knobStep(control({ name: "knob-st-c", value: 0 }))).toBe(1);
  });
});

describe("createKnobs", () => {
  it("stamps a bound element and keeps its aria values following the control", async () => {
    const eps = control({ name: "knob-eps-a", value: 0.2, min: 0, max: 1, step: 0.05 });
    const r = rig();
    r.knobs.bind(r.a, { control: eps });
    expect(r.a.classList.contains("aiui-knob")).toBe(true);
    expect(r.a.getAttribute("data-control")).toBe("knob-eps-a");
    expect(r.a.getAttribute("role")).toBe("slider");
    expect(r.a.getAttribute("tabindex")).toBe("0");
    expect(r.a.getAttribute("aria-label")).toBe("knob-eps-a");
    expect(r.a.getAttribute("aria-valuemin")).toBe("0");
    expect(r.a.getAttribute("aria-valuemax")).toBe("1");
    expect(r.a.getAttribute("aria-valuenow")).toBe("0.2");
    expect(r.a.getAttribute("aria-valuetext")).toBe("0.20");

    eps.set(0.5);
    await tick();
    expect(r.a.getAttribute("aria-valuenow")).toBe("0.5");
    expect(r.a.getAttribute("aria-valuetext")).toBe("0.50");

    // Rebinding with a formatter updates in place; the value text follows it.
    r.knobs.bind(r.a, { control: eps, format: (v) => `${v * 100}%` });
    expect(r.a.getAttribute("aria-valuetext")).toBe("50%");

    r.knobs.unbind(r.a);
    expect(r.a.classList.contains("aiui-knob")).toBe(false);
    expect(r.a.hasAttribute("data-control")).toBe(false);
    expect(r.a.hasAttribute("role")).toBe(false);
    expect(r.a.hasAttribute("aria-valuenow")).toBe(false);
    eps.set(0.7);
    await tick();
    expect(r.a.hasAttribute("aria-valuenow")).toBe(false); // forgotten: no longer followed
  });

  it("a drag crosses the range over the span and ends on the document", async () => {
    const eps = control({ name: "knob-eps-b", value: 0.2, min: 0, max: 1, step: 0.05 });
    const r = rig();
    r.knobs.bind(r.b, { control: eps, span: 240 });
    // A press on an element INSIDE the knob resolves to the knob.
    r.inner.dispatchEvent(new PE("pointerdown", { bubbles: true, button: 0, clientX: 100 }));
    expect(r.b.getAttribute("data-scrubbing")).toBe("true");
    // The move arrives on the document, not the host: no capture was possible.
    document.body.dispatchEvent(new PE("pointermove", { bubbles: true, clientX: 160 })); // 60 of 240 px: +0.25
    await tick();
    expect(eps.get()).toBeCloseTo(0.45, 9);
    document.body.dispatchEvent(new PE("pointermove", { bubbles: true, clientX: 1000 })); // clamped
    await tick();
    expect(eps.get()).toBe(1);
    document.body.dispatchEvent(new PE("pointerup", { bubbles: true }));
    expect(r.b.hasAttribute("data-scrubbing")).toBe(false);
    // The document listeners are gone with the drag.
    document.body.dispatchEvent(new PE("pointermove", { bubbles: true, clientX: 0 }));
    await tick();
    expect(eps.get()).toBe(1);
    // A press on a non-knob does nothing.
    r.a.dispatchEvent(new PE("pointerdown", { bubbles: true, button: 0, clientX: 0 }));
    expect(r.a.hasAttribute("data-scrubbing")).toBe(false);
    // A secondary button does not start a drag.
    r.b.dispatchEvent(new PE("pointerdown", { bubbles: true, button: 2, clientX: 0 }));
    expect(r.b.hasAttribute("data-scrubbing")).toBe(false);
  });

  it("arrow keys step the focused knob; Shift multiplies by ten; Home and End go to the bounds", async () => {
    const eps = control({ name: "knob-eps-c", value: 0.2, min: 0, max: 1, step: 0.05 });
    const r = rig();
    r.knobs.bind(r.a, { control: eps });
    const key = (el: Element, k: string, shiftKey = false) =>
      el.dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey, bubbles: true }));
    key(r.a, "ArrowRight");
    await tick();
    expect(eps.get()).toBeCloseTo(0.25, 9);
    key(r.a, "ArrowUp");
    await tick();
    expect(eps.get()).toBeCloseTo(0.3, 9);
    key(r.a, "ArrowLeft", true); // ten steps down, clamped at the floor
    await tick();
    expect(eps.get()).toBe(0);
    key(r.a, "End");
    await tick();
    expect(eps.get()).toBe(1);
    key(r.a, "Home");
    await tick();
    expect(eps.get()).toBe(0);
    key(r.a, "Enter"); // not a knob key: untouched
    key(r.b, "ArrowRight"); // not a knob: untouched
    await tick();
    expect(eps.get()).toBe(0);
  });

  it("the readout follows the hot knob: scrubbing, else focused, else hovered", async () => {
    const eps = control({ name: "knob-eps-d", value: 0.2, min: 0, max: 1, step: 0.05 });
    const beta = control({ name: "lab/knob-beta-d", value: 3, min: 0, max: 10, step: 1 });
    const r = rig();
    r.knobs.bind(r.a, { control: eps });
    r.knobs.bind(r.b, { control: beta, format: (v) => `${v} epochs` });
    expect(readout(r.root)).toBeNull();

    r.inner.dispatchEvent(new PE("pointerover", { bubbles: true }));
    await tick();
    expect(r.knobs.hot()?.el).toBe(r.b);
    expect(readout(r.root)?.textContent).toBe("3 epochsknob-beta-d"); // the leaf name
    expect(readout(r.root)?.getAttribute("data-control")).toBe("lab/knob-beta-d");

    r.a.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    await tick();
    expect(r.knobs.hot()?.el).toBe(r.a); // focus beats hover
    expect(readout(r.root)?.textContent).toContain("0.20");

    r.inner.dispatchEvent(new PE("pointerdown", { bubbles: true, button: 0, clientX: 0 }));
    await tick();
    expect(r.knobs.hot()?.el).toBe(r.b); // scrubbing beats focus
    document.body.dispatchEvent(new PE("pointerup", { bubbles: true }));
    await tick();
    expect(r.knobs.hot()?.el).toBe(r.a);

    r.a.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    r.host.dispatchEvent(new PE("pointerleave"));
    await tick();
    expect(r.knobs.hot()).toBeUndefined();
    expect(readout(r.root)).toBeNull();
  });

  it("a consumer's own resolve maps a hit area onto the knob element", async () => {
    const eps = control({ name: "knob-eps-e", value: 0.2, min: 0, max: 1, step: 0.05 });
    // A press on `a` scrubs `b`: the consumer says which element a target stands for.
    const r = rig({ resolve: (t) => (t.classList.contains("a") ? r.b : undefined) });
    r.knobs.bind(r.b, { control: eps });
    r.inner.dispatchEvent(new PE("pointerdown", { bubbles: true, button: 0, clientX: 0 }));
    expect(r.b.hasAttribute("data-scrubbing")).toBe(false); // not resolved by the consumer
    r.a.dispatchEvent(new PE("pointerdown", { bubbles: true, button: 0, clientX: 0 }));
    expect(r.b.getAttribute("data-scrubbing")).toBe("true");
    document.body.dispatchEvent(new PE("pointermove", { bubbles: true, clientX: 24 })); // +0.1
    await tick();
    expect(eps.get()).toBeCloseTo(0.3, 9);
    document.body.dispatchEvent(new PE("pointerup", { bubbles: true }));
  });

  it("a drag follows its control onto a replacement element", async () => {
    const eps = control({ name: "knob-eps-f", value: 0.2, min: 0, max: 1, step: 0.05 });
    const r = rig();
    r.knobs.bind(r.a, { control: eps });
    r.a.dispatchEvent(new PE("pointerdown", { bubbles: true, button: 0, clientX: 100 }));
    // The consumer re-renders: the old element goes, a new one is bound.
    const fresh = document.createElement("span");
    fresh.className = "a2";
    r.a.replaceWith(fresh);
    r.knobs.clear();
    expect(r.a.hasAttribute("data-control")).toBe(false);
    r.knobs.bind(fresh, { control: eps });
    expect(fresh.getAttribute("data-scrubbing")).toBe("true");
    await tick(); // the hot signal is a staged write
    expect(r.knobs.hot()?.el).toBe(fresh);
    document.body.dispatchEvent(new PE("pointermove", { bubbles: true, clientX: 160 }));
    await tick();
    expect(eps.get()).toBeCloseTo(0.45, 9);
    document.body.dispatchEvent(new PE("pointerup", { bubbles: true }));
    expect(fresh.hasAttribute("data-scrubbing")).toBe(false);
  });
});
