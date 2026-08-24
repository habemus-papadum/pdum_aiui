// @vitest-environment jsdom
/**
 * lens.dom.test.tsx — the Lens's tier lifecycle: click opens the detail
 * overlay (portaled to body, mounted on open), Escape and the close button
 * dismiss it (disposed on close), focus returns to the trigger.
 */
import { render } from "@solidjs/web";
import { afterEach, describe, expect, it } from "vitest";
import { Lens } from "./lens";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

let host: HTMLElement | undefined;
let unmount: (() => void) | undefined;

afterEach(() => {
  unmount?.();
  host?.remove();
  unmount = host = undefined;
});

function mount(component: () => unknown): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  unmount = render(component as never, host);
  return host;
}

function mountLens(): HTMLElement {
  return mount(() => (
    <p>
      the{" "}
      <Lens label="line of action" detail={() => <div class="full">the full construction</div>}>
        line of action
      </Lens>{" "}
      never rotates
    </p>
  ));
}

describe("Lens", () => {
  it("click opens the detail overlay; the detail mounts only then", async () => {
    const el = mountLens();
    expect(document.querySelector(".aiui-lens-overlay")).toBeNull();
    el.querySelector<HTMLButtonElement>(".aiui-lens-trigger")?.click();
    await tick();
    const overlay = document.querySelector(".aiui-lens-overlay");
    expect(overlay).not.toBeNull();
    expect(overlay?.querySelector(".full")?.textContent).toBe("the full construction");
  });

  it("Escape closes and disposes the detail, restoring trigger focus", async () => {
    const el = mountLens();
    const trigger = el.querySelector<HTMLButtonElement>(".aiui-lens-trigger");
    trigger?.click();
    await tick();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();
    expect(document.querySelector(".aiui-lens-overlay")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("the ✕ button closes too (no keyboard assumed)", async () => {
    const el = mountLens();
    el.querySelector<HTMLButtonElement>(".aiui-lens-trigger")?.click();
    await tick();
    document.querySelector<HTMLButtonElement>(".aiui-lens-close")?.click();
    await tick();
    expect(document.querySelector(".aiui-lens-overlay")).toBeNull();
  });

  it("panelClass reaches the detail panel; the trigger keeps its own class", async () => {
    const el = mount(() => (
      <Lens
        label="the instrument"
        class="trigger-extra"
        panelClass="wide-instrument"
        detail={() => <div class="full">gauges</div>}
      >
        the instrument
      </Lens>
    ));
    const trigger = el.querySelector<HTMLButtonElement>(".aiui-lens-trigger");
    expect(trigger?.classList.contains("trigger-extra")).toBe(true);
    expect(trigger?.classList.contains("wide-instrument")).toBe(false);
    trigger?.click();
    await tick();
    const panel = document.querySelector(".aiui-lens-panel");
    expect(panel?.classList.contains("wide-instrument")).toBe(true);
  });

  it("nested lenses close as a ladder: Escape takes the topmost only", async () => {
    const el = mount(() => (
      <Lens
        label="the outer instrument"
        detail={() => (
          <div class="outer-detail">
            gauges, and{" "}
            <Lens label="the inner calculator" detail={() => <div class="inner-detail">sums</div>}>
              the inner calculator
            </Lens>
          </div>
        )}
      >
        the outer instrument
      </Lens>
    ));
    el.querySelector<HTMLButtonElement>(".aiui-lens-trigger")?.click();
    await tick();
    document
      .querySelector(".outer-detail")
      ?.querySelector<HTMLButtonElement>(".aiui-lens-trigger")
      ?.click();
    await tick();
    expect(document.querySelectorAll(".aiui-lens-overlay")).toHaveLength(2);

    // one Escape: the inner surface closes, its host stays
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();
    expect(document.querySelector(".inner-detail")).toBeNull();
    expect(document.querySelector(".outer-detail")).not.toBeNull();

    // a click inside the inner panel must not fall through to the host —
    // covered by the same seniority guard; the second Escape ends the ladder
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();
    expect(document.querySelectorAll(".aiui-lens-overlay")).toHaveLength(0);
  });

  it("outside pointerdown closes an open lens", async () => {
    const el = mountLens();
    el.querySelector<HTMLButtonElement>(".aiui-lens-trigger")?.click();
    await tick();
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await tick();
    expect(document.querySelector(".aiui-lens-overlay")).toBeNull();
  });
});
