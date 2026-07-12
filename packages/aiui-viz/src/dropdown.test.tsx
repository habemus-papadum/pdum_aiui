// @vitest-environment jsdom
/**
 * dropdown.test.tsx — the one behavior the widget owns: popup lifecycle with
 * a refresh hook. Open fires onOpen (every time, not once), outside
 * pointerdown closes, Escape closes, and the body's close() closes.
 */
import { render } from "@solidjs/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dropdown } from "./dropdown";
import { tick } from "./testing";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

function mount(onOpen: () => void): { trigger: HTMLButtonElement; pop: () => HTMLElement | null } {
  const host = document.createElement("div");
  document.body.append(host);
  dispose = render(
    () => (
      <Dropdown trigger={<span>chip</span>} onOpen={onOpen} class="chip" label="connection">
        {(close) => (
          <button type="button" class="item" onClick={close}>
            item
          </button>
        )}
      </Dropdown>
    ),
    host,
  );
  const trigger = host.querySelector("button.chip") as HTMLButtonElement;
  return { trigger, pop: () => host.querySelector(".aiui-dropdown-pop") };
}

describe("Dropdown", () => {
  it("opens on click, firing the refresh hook EVERY open", async () => {
    const onOpen = vi.fn();
    const { trigger, pop } = mount(onOpen);
    expect(pop()).toBeNull();

    trigger.click();
    await tick();
    expect(pop()).not.toBeNull();
    expect(onOpen).toHaveBeenCalledTimes(1);

    trigger.click(); // toggle closed — no refresh
    await tick();
    expect(pop()).toBeNull();
    expect(onOpen).toHaveBeenCalledTimes(1);

    trigger.click(); // reopen — refresh again
    await tick();
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("closes on outside pointerdown, on Escape, and via the body's close()", async () => {
    const { trigger, pop } = mount(() => {});

    trigger.click();
    await tick();
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await tick();
    expect(pop()).toBeNull();

    trigger.click();
    await tick();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();
    expect(pop()).toBeNull();

    trigger.click();
    await tick();
    (pop()?.querySelector(".item") as HTMLButtonElement).click();
    await tick();
    expect(pop()).toBeNull();
  });
});
