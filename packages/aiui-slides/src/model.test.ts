/**
 * model.test.ts — the deck model: the two frame controls' clamping (one
 * validator for slider, key, widget, agent), the frame walk over scenes
 * (forward plays, backward un-plays, boundaries re-enter at the right end),
 * the stepAt derivation, and the data-shape guards.
 */
import { scope } from "@habemus-papadum/aiui-viz";
import { resetControlSurface } from "@habemus-papadum/aiui-viz/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createDeckModel } from "./model";
import type { SlideDef } from "./types";

afterEach(() => resetControlSurface());

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const Blank = (): null => null;
const slides = (...ids: string[]): SlideDef[] =>
  ids.map((id) => ({ id, title: id, content: Blank }));
/** a (plain) → b (two scenes) → c (plain): the walk fixture. */
const scenic = (): SlideDef[] => [
  { id: "a", title: "a", content: Blank },
  { id: "b", title: "b", content: Blank, steps: 2 },
  { id: "c", title: "c", content: Blank },
];

describe("createDeckModel", () => {
  it("registers slide and step controls under the scope with clamping meta", () => {
    const m = createDeckModel(scope("t-meta"), scenic());
    expect(m.slide.name).toBe("t-meta/slide");
    expect(m.slide.meta).toMatchObject({ min: 0, max: 2, step: 1 });
    expect(m.step.name).toBe("t-meta/step");
    expect(m.step.meta).toMatchObject({ min: 0, max: 2, step: 1 });
    expect(m.count).toBe(3);
    expect(m.stepsOf(1)).toBe(2);
    expect(m.stepsOf(0)).toBe(0);
    expect(m.stepsOf(99)).toBe(0);
  });

  it("goTo clamps through the control's own validation and rewinds scenes", async () => {
    const m = createDeckModel(scope("t-clamp"), scenic());
    m.goToFrame(1, 2);
    await tick();
    expect(m.step.get()).toBe(2);
    m.goTo(99);
    await tick();
    expect(m.slide.get()).toBe(2);
    expect(m.step.get()).toBe(0); // a jump lands on the slide's initial state
    m.goTo(-5);
    await tick();
    expect(m.slide.get()).toBe(0);
  });

  it("walks forward scene by scene, then slides; backward mirrors exactly", async () => {
    // Walks read the COMMITTED frame, so each one gets its microtask —
    // exactly what every real input source (an event, a tool call) provides.
    const m = createDeckModel(scope("t-walk"), scenic());
    const forward: (typeof m.goForward extends () => infer R ? R : never)[] = [];
    for (let i = 0; i < 5; i++) {
      forward.push(m.goForward());
      await tick();
    }
    expect(forward).toEqual([
      { slide: 1, step: 0 }, // a → b
      { slide: 1, step: 1 }, // b plays scene 1
      { slide: 1, step: 2 }, // …and scene 2
      { slide: 2, step: 0 }, // scenes spent → c
      { slide: 2, step: 0 }, // the end holds
    ]);
    expect(m.atEnd()).toBe(true);
    const backward: (typeof forward)[number][] = [];
    for (let i = 0; i < 5; i++) {
      backward.push(m.goBack());
      await tick();
    }
    expect(backward).toEqual([
      { slide: 1, step: 2 }, // re-enter at the LAST scene
      { slide: 1, step: 1 }, // un-play
      { slide: 1, step: 0 },
      { slide: 0, step: 0 },
      { slide: 0, step: 0 }, // the start holds
    ]);
    expect(m.atStart()).toBe(true);
  });

  it("goToFrame clamps the step to ITS slide; a stale over-step reads as played-out", async () => {
    const m = createDeckModel(scope("t-frame"), scenic());
    expect(m.goToFrame(2, 9)).toEqual({ slide: 2, step: 0 }); // c has no scenes
    expect(m.goToFrame(1, 9)).toEqual({ slide: 1, step: 2 });
    // A raw agent write can exceed the current slide's count (control max is
    // the deck-wide max): the walk treats it as "all played".
    m.goToFrame(1, 1);
    await tick();
    m.step.set(2);
    await tick();
    expect(m.goForward()).toEqual({ slide: 2, step: 0 });
  });

  it("stepAt: passed slides hold their final state, unreached ones their first", async () => {
    const m = createDeckModel(scope("t-at"), scenic());
    m.goToFrame(1, 1);
    await tick();
    expect(m.stepAt(0)).toBe(0);
    expect(m.stepAt(1)).toBe(1);
    expect(m.stepAt(2)).toBe(0);
    m.goTo(2);
    await tick();
    expect(m.stepAt(1)).toBe(2); // passed → fully played
  });

  it("next/prev advance one frame and no-op at the ends, reporting what they wrote", async () => {
    const m = createDeckModel(scope("t-verbs"), slides("a", "b"));
    expect(m.next.run()).toEqual({ slide: 1, step: 0 });
    await tick();
    expect(m.slide.get()).toBe(1);
    expect(m.next.run()).toEqual({ slide: 1, step: 0 }); // already last
    expect(m.prev.run()).toEqual({ slide: 0, step: 0 });
    await tick();
    expect(m.slide.get()).toBe(0);
    expect(m.prev.run()).toEqual({ slide: 0, step: 0 }); // already first
  });

  it("rejects an empty deck, duplicate slide ids, and bad step counts", () => {
    expect(() => createDeckModel(scope("t-empty"), [])).toThrow(/at least one/);
    expect(() => createDeckModel(scope("t-dupe"), slides("a", "a"))).toThrow(/duplicate/);
    expect(() =>
      createDeckModel(scope("t-neg"), [{ id: "a", title: "a", content: Blank, steps: -1 }]),
    ).toThrow(/invalid steps/);
    expect(() =>
      createDeckModel(scope("t-frac"), [{ id: "a", title: "a", content: Blank, steps: 1.5 }]),
    ).toThrow(/invalid steps/);
  });
});
