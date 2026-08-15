/**
 * model.test.ts — the deck model: the slide control's clamping (one
 * validator for slider, key, widget, agent), the verbs at the ends, and the
 * data-shape guards.
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

describe("createDeckModel", () => {
  it("registers the slide control under the scope with clamping meta", () => {
    const m = createDeckModel(scope("t-meta"), slides("a", "b", "c"));
    expect(m.slide.name).toBe("t-meta/slide");
    expect(m.slide.meta).toMatchObject({ min: 0, max: 2, step: 1 });
    expect(m.count).toBe(3);
  });

  it("goTo clamps through the control's own validation", async () => {
    const m = createDeckModel(scope("t-clamp"), slides("a", "b", "c"));
    m.goTo(99);
    await tick();
    expect(m.slide.get()).toBe(2);
    m.goTo(-5);
    await tick();
    expect(m.slide.get()).toBe(0);
  });

  it("next/prev advance and no-op at the ends, reporting what they wrote", async () => {
    const m = createDeckModel(scope("t-verbs"), slides("a", "b"));
    expect(m.next.run()).toEqual({ slide: 1 });
    await tick();
    expect(m.slide.get()).toBe(1);
    expect(m.next.run()).toEqual({ slide: 1 }); // already last
    expect(m.prev.run()).toEqual({ slide: 0 });
    await tick();
    expect(m.slide.get()).toBe(0);
    expect(m.prev.run()).toEqual({ slide: 0 }); // already first
  });

  it("rejects an empty deck and duplicate slide ids", () => {
    expect(() => createDeckModel(scope("t-empty"), [])).toThrow(/at least one/);
    expect(() => createDeckModel(scope("t-dupe"), slides("a", "a"))).toThrow(/duplicate/);
  });
});
