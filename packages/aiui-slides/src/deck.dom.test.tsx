// @vitest-environment jsdom
/**
 * deck.dom.test.tsx — the Deck in the DOM (headless — the interpreted-scroll
 * runtime is plain listeners + inline styles, so gestures exercise here too):
 * slides render on the translated track with boundaries, scenes advance
 * frame by frame through nav/keys/wheel/dots, the HUD stays slide-grained,
 * and the cue invites, retires, and returns on idle.
 */
import { scope } from "@habemus-papadum/aiui-viz";
import { resetControlSurface } from "@habemus-papadum/aiui-viz/testing";
import { render } from "@solidjs/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Deck } from "./deck";
import { Lens } from "./lens";
import { createDeckModel } from "./model";
import { Step } from "./step";
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

/** title → a two-scene slide (Step-built) → coda. */
function scenicDeck() {
  return deck([
    { id: "title", title: "Title", content: () => <h1>title</h1> },
    {
      id: "build",
      title: "Build",
      content: () => (
        <div>
          <p>always</p>
          <Step at={1}>scene one</Step>
          <Step at={2}>scene two</Step>
        </div>
      ),
      steps: 2,
    },
    { id: "coda", title: "Coda", content: () => <h1>coda</h1> },
  ]);
}

const wheel = (el: Element, deltaY: number, timeStamp?: number): void => {
  const e = new WheelEvent("wheel", { deltaY, cancelable: true, bubbles: true });
  if (timeStamp !== undefined) {
    Object.defineProperty(e, "timeStamp", { value: timeStamp });
  }
  el.dispatchEvent(e);
};

/** jsdom has no TouchEvent: a plain Event wearing `touches` exercises the
 * same listeners. Dispatch on the element the finger lands on. */
const touchAt = (el: Element, type: string, y: number): void => {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, "touches", { value: [{ clientY: y }] });
  el.dispatchEvent(e);
};

/** Dress an element as a scrollable region (jsdom's layout is all zeros):
 * inline overflow so getComputedStyle sees it, geometry via defineProperty,
 * scrollTop as a plain writable field. */
const makeScrollable = (el: HTMLElement, scrollTop: number): void => {
  el.style.overflowY = "auto";
  Object.defineProperty(el, "scrollHeight", { value: 800, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: 600, configurable: true });
  Object.defineProperty(el, "scrollTop", { value: scrollTop, writable: true, configurable: true });
};

describe("Deck", () => {
  it("renders every slide in order on the track, each inside its own boundary", () => {
    const el = mount(() => <Deck model={deck()} />);
    const track = el.querySelector<HTMLElement>(".aiui-deck-track");
    expect(track?.style.transform).toBe("translateY(-0%)");
    const sections = el.querySelectorAll(".aiui-deck-slide");
    expect(sections.length).toBe(3);
    expect(sections[0].getAttribute("data-slide-id")).toBe("one");
    expect(el.textContent).toContain("first slide");
    expect(el.textContent).toContain("third slide");
  });

  it("lens surfaces mount into the deck's layer, out of the transformed track", async () => {
    // Regression: the translated track (and a Step row mid-transition) is a
    // fixed-position containing block — an overlay left on the track rendered
    // a full viewport off-screen (found live on /deck/swarms scene 3).
    const m = deck([
      { id: "one", title: "One", content: () => <h1>first</h1> },
      {
        id: "two",
        title: "Two",
        content: () => (
          <p>
            <Lens label="depth" detail={() => <p>the detail</p>}>
              a term
            </Lens>
          </p>
        ),
      },
    ]);
    const el = mount(() => <Deck model={m} />);
    el.querySelector<HTMLButtonElement>(".aiui-lens-trigger")?.click();
    await tick();
    const overlay = el.querySelector(".aiui-lens-overlay");
    expect(overlay).not.toBeNull();
    expect(overlay?.parentElement?.className).toBe("aiui-deck-layer");
    expect(overlay?.closest(".aiui-deck-track")).toBeNull();
    expect(overlay?.closest(".aiui-deck")).not.toBeNull(); // token scope kept

    // And CLOSING removes the moved node: Solid's branch disposal walks the
    // <Show>'s marker span, which the reparented surface has left — the Lens
    // must remove it itself (the unclosable-zombie regression).
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();
    expect(el.querySelector(".aiui-lens-overlay")).toBeNull();
    expect(document.querySelector(".aiui-lens-overlay")).toBeNull();
  });

  it("navigation drops focus left in slide content; deck chrome keeps its own", async () => {
    // Regression: a clicked link stayed focused after the frame moved — the
    // next keydown promoted it to a :focus-visible ring (a phantom box on
    // /deck/swarms), and Enter would have re-fired it.
    const m = deck([
      { id: "one", title: "One", content: () => <h1>first</h1> },
      {
        id: "two",
        title: "Two",
        content: () => (
          <p>
            <a href="https://example.com/">the lineage paper</a>
          </p>
        ),
      },
    ]);
    const el = mount(() => <Deck model={m} />);
    m.goToFrame(1, 0);
    await tick();
    const link = el.querySelector<HTMLAnchorElement>("a[href='https://example.com/']");
    link?.focus();
    expect(document.activeElement).toBe(link);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", cancelable: true }));
    await tick();
    expect(m.slide.get()).toBe(0);
    expect(document.activeElement).not.toBe(link); // swept with the frame

    // Chrome is OUTSIDE the sweep: the nav button survives its own click.
    const next = el.querySelectorAll<HTMLButtonElement>(".aiui-deck-nav-btn")[1];
    next.focus();
    next.click();
    await tick();
    expect(m.slide.get()).toBe(1);
    expect(document.activeElement).toBe(next);
  });

  it("deep link: a slide tail seeds the frame from the URL, off the owned scope", async () => {
    // Regression: the seed used to write controls synchronously in the Deck's
    // component body — REACTIVE_WRITE_IN_OWNED_SCOPE in dev (found live on a
    // /deck/swarms reload). The capture is sync; the write is a microtask.
    history.replaceState(null, "", "/show/three");
    try {
      const m = deck();
      const el = mount(() => <Deck model={m} basePath="/show" />);
      await tick();
      expect(m.slide.get()).toBe(2);
      expect(el.querySelector<HTMLElement>(".aiui-deck-track")?.style.transform).toBe(
        "translateY(-200%)",
      );
      expect(location.pathname).toBe("/show/three");
    } finally {
      history.replaceState(null, "", "/");
    }
  });

  it("nav widget: next/prev move the model and the track, ends disable", async () => {
    const m = deck();
    const el = mount(() => <Deck model={m} />);
    const buttons = el.querySelectorAll<HTMLButtonElement>(".aiui-deck-nav-btn");
    const [prev, next] = [buttons[0], buttons[1]];
    expect(prev.disabled).toBe(true);
    next.click();
    await tick();
    expect(m.slide.get()).toBe(1);
    expect(el.querySelector<HTMLElement>(".aiui-deck-track")?.style.transform).toBe(
      "translateY(-100%)",
    );
    next.click();
    await tick();
    expect(m.slide.get()).toBe(2);
    expect(el.querySelector(".aiui-deck-nav-now")?.textContent).toBe("3");
    expect(el.querySelectorAll<HTMLButtonElement>(".aiui-deck-nav-btn")[1].disabled).toBe(true);
    prev.click();
    await tick();
    expect(m.slide.get()).toBe(1);
  });

  it("scenes: one frame per input — keys play scenes before slides, Steps flip, dots track", async () => {
    const m = scenicDeck();
    const el = mount(() => <Deck model={m} />);
    const key = (k: string) =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: k, cancelable: true }));
    expect(el.querySelector(".aiui-deck-dots")).toBeNull(); // title has no scenes
    key("ArrowDown");
    await tick();
    expect(m.slide.get()).toBe(1);
    expect(m.step.get()).toBe(0);
    const steps = el.querySelectorAll(".aiui-step");
    expect(steps[0].classList.contains("is-in")).toBe(false);
    const dots = el.querySelectorAll(".aiui-deck-dot");
    expect(dots.length).toBe(3); // initial state + two scenes
    key("ArrowDown");
    await tick();
    expect(m.slide.get()).toBe(1); // the slide HELD — the scroll played a scene
    expect(m.step.get()).toBe(1);
    expect(steps[0].classList.contains("is-in")).toBe(true);
    expect(steps[1].classList.contains("is-in")).toBe(false);
    key("ArrowDown");
    await tick();
    expect(m.step.get()).toBe(2);
    key("ArrowDown");
    await tick();
    expect(m.slide.get()).toBe(2); // scenes spent → the slide moves
    key("ArrowUp");
    await tick();
    expect(m.slide.get()).toBe(1);
    expect(m.step.get()).toBe(2); // backing in re-enters at the LAST scene
    key("ArrowUp");
    await tick();
    expect(m.step.get()).toBe(1); // …and un-plays
    expect(el.querySelectorAll(".aiui-step")[1].classList.contains("is-in")).toBe(false);
  });

  it("dots: tapping one jumps to that scene state within the slide", async () => {
    const m = scenicDeck();
    const el = mount(() => <Deck model={m} />);
    m.goToFrame(1, 0);
    await tick();
    const dots = el.querySelectorAll<HTMLButtonElement>(".aiui-deck-dot");
    dots[2].click();
    await tick();
    expect(m.slide.get()).toBe(1);
    expect(m.step.get()).toBe(2);
    expect(dots[2].classList.contains("is-current")).toBe(true);
  });

  it("wheel: one burst is one frame, tail swallowed; a later burst steps again", async () => {
    const m = deck();
    const el = mount(() => <Deck model={m} />);
    const viewport = el.querySelector<HTMLElement>(".aiui-deck-viewport");
    if (!viewport) throw new Error("no viewport");
    wheel(viewport, 120, 1000);
    wheel(viewport, 60, 1030); // inertia tail
    wheel(viewport, 30, 1060);
    await tick();
    expect(m.slide.get()).toBe(1);
    wheel(viewport, 120, 2000); // a fresh gesture after quiet
    await tick();
    expect(m.slide.get()).toBe(2);
    wheel(viewport, -120, 3000);
    await tick();
    expect(m.slide.get()).toBe(1);
  });

  it("touch: a swipe at a scrollable slide's bottom edge steps the deck", async () => {
    // Regression: the hole test was direction-blind for touch — any
    // scrollable slide ate EVERY swipe, so a phone stalled after the first
    // swipe scrolled the overflow to its edge.
    const m = deck();
    const el = mount(() => <Deck model={m} />);
    const viewport = el.querySelector<HTMLElement>(".aiui-deck-viewport");
    const frame = el.querySelector<HTMLElement>(".aiui-deck-slide");
    if (!viewport || !frame) throw new Error("no viewport/frame");
    makeScrollable(frame, 200); // 200 + 600 = 800: scrolled to the bottom
    const content = frame.querySelector("h1") ?? frame;
    touchAt(content, "touchstart", 300);
    touchAt(content, "touchmove", 240); // forward, no travel left → the deck's
    await tick();
    expect(m.slide.get()).toBe(1);
    touchAt(content, "touchend", 240);
  });

  it("touch: a swipe with scroll travel left stays the scroller's, start to end", async () => {
    const m = deck();
    const el = mount(() => <Deck model={m} />);
    const frame = el.querySelector<HTMLElement>(".aiui-deck-slide");
    if (!frame) throw new Error("no frame");
    makeScrollable(frame, 0); // top: forward travel available
    const content = frame.querySelector("h1") ?? frame;
    touchAt(content, "touchstart", 300);
    touchAt(content, "touchmove", 240); // hole verdict: the scroller's
    touchAt(content, "touchmove", 100); // still native, even past threshold
    await tick();
    expect(m.slide.get()).toBe(0);
    touchAt(content, "touchend", 100);
    // The NEXT gesture at the (now) bottom edge belongs to the deck.
    frame.scrollTop = 200;
    touchAt(content, "touchstart", 300);
    touchAt(content, "touchmove", 240);
    await tick();
    expect(m.slide.get()).toBe(1);
  });

  it("HUD: opens from the counter, shows previews and typo tiles, jumps slide-grained", async () => {
    const m = scenicDeck();
    const el = mount(() => <Deck model={m} />);
    m.goToFrame(1, 2);
    await tick();
    el.querySelector<HTMLButtonElement>(".aiui-deck-nav-count")?.click();
    await tick();
    const tiles = el.querySelectorAll<HTMLButtonElement>(".aiui-deck-hud-tile");
    expect(tiles.length).toBe(3);
    tiles[2].click();
    await tick();
    expect(m.slide.get()).toBe(2);
    expect(m.step.get()).toBe(0); // a jump lands on the slide's initial state
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

  it("cue: invites on the title frame, one frame per tap, retires on movement", async () => {
    const m = scenicDeck();
    const el = mount(() => <Deck model={m} />);
    const cue = el.querySelector<HTMLButtonElement>(".aiui-deck-cue");
    expect(cue?.classList.contains("is-hidden")).toBe(false);
    cue?.click();
    await tick();
    expect(m.slide.get()).toBe(1);
    expect(cue?.classList.contains("is-hidden")).toBe(true);
    cue?.click(); // hidden: pointer-events none in real CSS; the click still
    await tick(); // routes one frame in jsdom, harmless either way
    expect(m.slide.get()).toBe(1);
    expect(m.step.get()).toBe(1); // ONE step — a scene, not a slide
  });

  it("cue: returns after idleMs of rest, pointing back at the very end", async () => {
    vi.useFakeTimers();
    try {
      const m = deck();
      const el = mount(() => <Deck model={m} />);
      await vi.advanceTimersByTimeAsync(0);
      const cue = el.querySelector<HTMLButtonElement>(".aiui-deck-cue");
      m.goToFrame(2, 0); // jump to the end
      await vi.advanceTimersByTimeAsync(0);
      expect(cue?.classList.contains("is-hidden")).toBe(true);
      await vi.advanceTimersByTimeAsync(10_100);
      expect(cue?.classList.contains("is-hidden")).toBe(false);
      expect(cue?.classList.contains("is-up")).toBe(true); // nothing ahead
      cue?.click();
      await vi.advanceTimersByTimeAsync(0);
      expect(m.slide.get()).toBe(1); // the up cue steps BACK
    } finally {
      vi.useRealTimers();
    }
  });
});
