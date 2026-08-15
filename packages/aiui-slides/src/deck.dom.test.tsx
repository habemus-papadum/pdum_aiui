// @vitest-environment jsdom
/**
 * deck.dom.test.tsx — the Deck in the DOM (headless: no IntersectionObserver,
 * no scrollIntoView — both feature-checked): slides render with boundaries,
 * the nav widget drives the model through the live keymap, the HUD opens
 * with previews and navigates, the cue fades after slide 0.
 */
import { scope } from "@habemus-papadum/aiui-viz";
import { resetControlSurface } from "@habemus-papadum/aiui-viz/testing";
import { render } from "@solidjs/web";
import { afterEach, describe, expect, it } from "vitest";
import { Deck } from "./deck";
import { createDeckModel } from "./model";
import type { SlideDef } from "./types";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

let host: HTMLElement | undefined;
let unmount: (() => void) | undefined;

afterEach(() => {
  unmount?.();
  host?.remove();
  unmount = host = undefined;
  resetControlSurface();
});

function mount(component: () => unknown): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  unmount = render(component as never, host);
  return host;
}

let n = 0;
function deck(defs?: SlideDef[]) {
  const slides = defs ?? [
    { id: "one", title: "One", content: () => <h1>first slide</h1> },
    {
      id: "two",
      title: "Two",
      content: () => <h1>second slide</h1>,
      preview: () => <span class="mini">II</span>,
    },
    { id: "three", title: "Three", content: () => <h1>third slide</h1> },
  ];
  return createDeckModel(scope(`dom${n++}`), slides);
}

describe("Deck", () => {
  it("renders every slide in order, each inside its own boundary", () => {
    const el = mount(() => <Deck model={deck()} />);
    const sections = el.querySelectorAll(".aiui-deck-slide");
    expect(sections.length).toBe(3);
    expect(sections[0].getAttribute("data-slide-id")).toBe("one");
    expect(el.textContent).toContain("first slide");
    expect(el.textContent).toContain("third slide");
  });

  it("nav widget: next/prev move the model, ends disable", async () => {
    const m = deck();
    const el = mount(() => <Deck model={m} />);
    const buttons = el.querySelectorAll<HTMLButtonElement>(".aiui-deck-nav-btn");
    const [prev, next] = [buttons[0], buttons[1]];
    expect(prev.disabled).toBe(true);
    next.click();
    await tick();
    expect(m.slide.get()).toBe(1);
    next.click();
    await tick();
    expect(m.slide.get()).toBe(2);
    expect(el.querySelector(".aiui-deck-nav-now")?.textContent).toBe("3");
    expect(el.querySelectorAll<HTMLButtonElement>(".aiui-deck-nav-btn")[1].disabled).toBe(true);
    prev.click();
    await tick();
    expect(m.slide.get()).toBe(1);
  });

  it("HUD: opens from the counter, shows previews and typo tiles, navigates", async () => {
    const m = deck();
    const el = mount(() => <Deck model={m} />);
    expect(el.querySelector(".aiui-deck-hud")).toBeNull();
    el.querySelector<HTMLButtonElement>(".aiui-deck-nav-count")?.click();
    await tick();
    const hud = el.querySelector(".aiui-deck-hud");
    expect(hud).not.toBeNull();
    const tiles = el.querySelectorAll<HTMLButtonElement>(".aiui-deck-hud-tile");
    expect(tiles.length).toBe(3);
    expect(tiles[1].querySelector(".mini")?.textContent).toBe("II"); // live preview
    expect(tiles[0].querySelector(".aiui-deck-hud-typo")?.textContent).toBe("1"); // typo tile
    tiles[2].click();
    await tick();
    expect(m.slide.get()).toBe(2);
    expect(el.querySelector(".aiui-deck-hud")).toBeNull(); // closed on choose
  });

  it("keyboard: document keydowns drive the deck; Escape closes the HUD only", async () => {
    const m = deck();
    const el = mount(() => <Deck model={m} />);
    const key = (k: string) =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: k, cancelable: true }));
    key("ArrowDown");
    await tick();
    expect(m.slide.get()).toBe(1);
    key("o");
    await tick();
    expect(el.querySelector(".aiui-deck-hud")).not.toBeNull();
    key("Escape");
    await tick();
    expect(el.querySelector(".aiui-deck-hud")).toBeNull();
    expect(m.slide.get()).toBe(1); // Escape never moved the deck
  });

  it("cue: visible on the title slide, hidden after, click advances", async () => {
    const m = deck();
    const el = mount(() => <Deck model={m} />);
    const cue = el.querySelector<HTMLButtonElement>(".aiui-deck-cue");
    expect(cue?.classList.contains("is-hidden")).toBe(false);
    cue?.click();
    await tick();
    expect(m.slide.get()).toBe(1);
    expect(cue?.classList.contains("is-hidden")).toBe(true);
  });
});
