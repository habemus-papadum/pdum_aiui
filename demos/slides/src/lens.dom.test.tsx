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

  it("outside pointerdown closes an open lens", async () => {
    const el = mountLens();
    el.querySelector<HTMLButtonElement>(".aiui-lens-trigger")?.click();
    await tick();
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await tick();
    expect(document.querySelector(".aiui-lens-overlay")).toBeNull();
  });
});
