// @vitest-environment jsdom
/**
 * side-panel-zoom.test.ts — the side panel's own zoom (⌘⇧+/⌘⇧−/⌘⇧0). Pins the
 * two things the old shared binding got wrong: it is the SHIFT chord (so the
 * browser's ⌘+/⌘−/⌘0 accelerators, which never reached the side panel, are not
 * what we listen for), and it matches by physical `event.code` (so ⌘⇧− actually
 * fires — a shifted "-" is "_", which the old `event.key === "-"` never caught).
 */
import { flush } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { uiScale } from "../config";
import { installSidePanelZoom } from "./side-panel-zoom";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  uiScale.set(uiScale.initial as never);
  flush();
  document.documentElement.style.fontSize = "";
});

const press = (code: string, mods: { meta?: boolean; shift?: boolean } = {}): void => {
  document.dispatchEvent(
    new KeyboardEvent("keydown", {
      code,
      metaKey: mods.meta ?? false,
      shiftKey: mods.shift ?? false,
      bubbles: true,
      cancelable: true,
    }),
  );
};

describe("side-panel zoom — ⌘⇧+/⌘⇧−/⌘⇧0, extension only", () => {
  it("⌘⇧+ grows, ⌘⇧− shrinks, ⌘⇧0 resets — and the root font-size follows", () => {
    dispose = installSidePanelZoom();
    flush(); // the apply half lands the restored scale at boot
    expect(document.documentElement.style.fontSize).toBe("100%");

    press("Equal", { meta: true, shift: true }); // ⌘⇧+
    flush();
    expect(uiScale.get()).toBeCloseTo(1.1);
    expect(document.documentElement.style.fontSize).toBe("110%");

    press("Minus", { meta: true, shift: true }); // ⌘⇧−  (this is the branch the old code missed)
    press("Minus", { meta: true, shift: true });
    flush();
    expect(uiScale.get()).toBeCloseTo(0.9);
    expect(document.documentElement.style.fontSize).toBe("90%");

    press("Digit0", { meta: true, shift: true }); // ⌘⇧0
    flush();
    expect(uiScale.get()).toBe(1);
    expect(document.documentElement.style.fontSize).toBe("100%");
  });

  it("does NOT claim the browser's own ⌘+/⌘−/⌘0 (no shift) — that is why shift exists", () => {
    dispose = installSidePanelZoom();
    press("Equal", { meta: true }); // plain ⌘= / ⌘+ — the browser's, left untouched
    press("Minus", { meta: true });
    press("Digit0", { meta: true });
    press("Equal", { shift: true }); // ⇧+ with no meta — not our chord either
    flush();
    expect(uiScale.get()).toBe(1); // nothing moved
  });

  it("clamps at the control's bounds (0.6–2), never runs away", () => {
    dispose = installSidePanelZoom();
    for (let i = 0; i < 30; i++) {
      press("Minus", { meta: true, shift: true });
    }
    flush();
    expect(uiScale.get()).toBe(0.6); // min, not below
    for (let i = 0; i < 40; i++) {
      press("Equal", { meta: true, shift: true });
    }
    flush();
    expect(uiScale.get()).toBe(2); // max, not above
  });
});
