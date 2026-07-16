// @vitest-environment jsdom
/**
 * side-panel-zoom.test.tsx — the side panel's zoom buttons. Both halves: the
 * buttons step/reset the uiScale control, and the apply effect lands the value
 * on the document's root font-size (the restore half — a scale set before mount
 * is applied the moment the component mounts).
 */
import { render } from "@solidjs/web";
import { flush } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { uiScale } from "../config";
import { SidePanelZoom } from "./side-panel-zoom";

const zoom = (): string => document.documentElement.style.getPropertyValue("zoom");

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  uiScale.set(uiScale.initial as never);
  flush();
  document.documentElement.style.removeProperty("zoom");
  document.body.replaceChildren();
});

function mount(): { minus: HTMLButtonElement; reset: HTMLButtonElement; plus: HTMLButtonElement } {
  const root = document.createElement("div");
  document.body.appendChild(root);
  dispose = render(() => <SidePanelZoom />, root);
  flush();
  const [minus, reset, plus] = [...root.querySelectorAll("button")] as HTMLButtonElement[];
  return { minus, reset, plus };
}

describe("SidePanelZoom — the side panel's zoom buttons", () => {
  it("+ grows, − shrinks, the middle button resets — the document zoom and label follow", () => {
    // Apply half: a value set BEFORE mount lands on the document at mount. It is
    // the CSS `zoom` (px content won't scale off a root font-size), the readout
    // is the percent.
    uiScale.set(1.3 as never);
    flush();
    const { minus, reset, plus } = mount();
    expect(zoom()).toBe("1.3");
    expect(reset.textContent).toBe("130%");

    plus.click();
    flush();
    expect(uiScale.get()).toBeCloseTo(1.4);
    expect(zoom()).toBe("1.4");
    expect(reset.textContent).toBe("140%"); // the middle button is a live readout

    minus.click();
    minus.click();
    flush();
    expect(uiScale.get()).toBeCloseTo(1.2);

    reset.click(); // the readout doubles as reset-to-100%
    flush();
    expect(uiScale.get()).toBe(1);
    expect(zoom()).toBe("1");
    expect(reset.textContent).toBe("100%");
  });

  it("clamps at the control's bounds (0.6–2), never runs away on a held click", () => {
    const { minus, plus } = mount();
    for (let i = 0; i < 30; i++) {
      minus.click(); // rapid clicks in one tick: the updater form must still chain
    }
    flush();
    expect(uiScale.get()).toBe(0.6);
    for (let i = 0; i < 40; i++) {
      plus.click();
    }
    flush();
    expect(uiScale.get()).toBe(2);
  });
});
