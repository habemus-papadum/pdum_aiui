/**
 * model.ts — the deck's durable side: **the current frame is a pair of
 * controls**, not component state.
 *
 * A deck's position is a FRAME: (slide, step). `slide` is the slide index;
 * `step` is how far into the current slide's scenes the presentation has
 * played (types.ts `SlideDef.steps`; 0 = the slide as first seen). One
 * forward gesture — wheel, touch, key, cue tap, agent verb — advances ONE
 * frame: the next scene if the slide has one unplayed, else the next slide.
 * Backward mirrors exactly, so leaving a slide upward re-enters it at its
 * LAST scene and un-plays them one by one.
 *
 * Registering both as controls (plus the next/prev verbs) under the deck's
 * scope is what makes a deck an aiui app rather than a widget: the agent's
 * derived tools read them in `report`, move them with `set` ("go to slide 4")
 * or the verbs ("next" — the voice-drivable presentation), they survive HMR
 * like every control, and every piece of chrome — keymap, nav widget, HUD,
 * cue, step dots, URL binding — is a pure view/relay of these two values.
 * The overview surfaces (HUD grid, URL) stay slide-grained on purpose:
 * scenes are a slide's interior, invisible to the deck's table of contents.
 *
 * `stepAt(index)` is the one derivation slides render from: a passed slide
 * holds its FINAL state, an unreached slide its initial one, the current
 * slide the live step — so scrolling past and back never leaves a slide
 * half-played, and the derivation is continuous across every frame walk.
 *
 * Names are EXPLICIT (`name: "slide"`), not compiler-injected: this factory
 * must work in any consumer's toolchain, aiui compiler or not — the
 * documented escape hatch used deliberately (the oscillator slice shows the
 * compiler-dependent alternative).
 */
import {
  action,
  type ControlBox,
  control,
  type RegisteredAction,
  type Scope,
} from "@habemus-papadum/aiui-viz";
import { untrack } from "solid-js";
import type { SlideDef } from "./types";

/** One deck position: slide index + scene step within it. */
export interface DeckFrame {
  slide: number;
  step: number;
}

/** A deck's model: the slides (static data) + the frame controls. */
export interface DeckModel {
  /** The deck's instance scope — also the natural `toolsNs` for its page. */
  scope: Scope;
  slides: readonly SlideDef[];
  /** Current slide index (0-based) — one of the two durable navigation facts. */
  slide: ControlBox<number>;
  /** Current scene step within the current slide (0 = initial state). */
  step: ControlBox<number>;
  next: RegisteredAction;
  prev: RegisteredAction;
  count: number;
  /** Scene steps slide `index` declares (0 for a plain or out-of-range slide). */
  stepsOf(index: number): number;
  /** The step slide `index` RENDERS right now (reactive): full once passed,
   * 0 before reached, the live clamped step while current. */
  stepAt(index: number): number;
  /** At the very first frame (reactive) — nothing behind. */
  atStart(): boolean;
  /** At the very last frame (reactive) — nothing ahead. */
  atEnd(): boolean;
  /** Jump to a slide at its initial state (HUD tiles, URL, agent jumps). */
  goTo(index: number): void;
  /** Clamped frame write; returns what it wrote (never a same-tick re-read). */
  goToFrame(index: number, step: number): DeckFrame;
  /** One frame forward: next scene, else next slide (no-op at the end). */
  goForward(): DeckFrame;
  /** One frame back: un-play a scene, else previous slide at its LAST scene. */
  goBack(): DeckFrame;
}

/**
 * Declare one deck's control surface under `s`. Call once at module level
 * (store side of the durable/disposable split); the Deck component and every
 * navigation surface read this one instance.
 */
export function createDeckModel(s: Scope, slides: readonly SlideDef[]): DeckModel {
  if (slides.length === 0) {
    throw new Error("createDeckModel: a deck needs at least one slide");
  }
  const seen = new Set<string>();
  for (const def of slides) {
    if (seen.has(def.id)) {
      throw new Error(`createDeckModel: duplicate slide id "${def.id}"`);
    }
    seen.add(def.id);
    const steps = def.steps ?? 0;
    if (!Number.isInteger(steps) || steps < 0) {
      throw new Error(`createDeckModel: slide "${def.id}" has invalid steps ${steps}`);
    }
  }

  const stepsOf = (index: number): number =>
    index >= 0 && index < slides.length ? (slides[index].steps ?? 0) : 0;
  const maxSteps = Math.max(...slides.map((d) => d.steps ?? 0));

  const slide = control({
    scope: s,
    name: "slide",
    description:
      "Current slide (0-based). The deck glides to whatever this is set to; " +
      `slides in order: ${slides.map((d, i) => `${i}=${d.id}`).join(", ")}.`,
    value: 0,
    min: 0,
    max: slides.length - 1,
    step: 1,
  });

  const step = control({
    scope: s,
    name: "step",
    description:
      "Scene step within the current slide (0 = the slide's initial state). " +
      `Scene steps per slide: ${slides.map((d, i) => `${i}=${d.steps ?? 0}`).join(", ")}.`,
    value: 0,
    min: 0,
    max: maxSteps,
    step: 1,
  });

  // The COMMITTED frame, step clamped to the slide it is on — a raw agent
  // write can park `step` above the current slide's count; every walk and
  // render treats that as "all scenes played". Committed means: a walk
  // issued in the same synchronous burst as a previous write reads the OLD
  // frame (Solid commits at the next microtask — the never-read-back rule).
  // Every real input source (one event, one tool call) crosses a microtask
  // between walks, so no shadow state is kept here; a synthetic caller that
  // walks twice in one tick must flush between.
  const frame = (): DeckFrame =>
    untrack(() => {
      const i = slide.get();
      return { slide: i, step: Math.min(step.get(), stepsOf(i)) };
    });

  const goToFrame = (index: number, at: number): DeckFrame => {
    const i = Math.min(Math.max(index, 0), slides.length - 1);
    const st = Math.min(Math.max(at, 0), stepsOf(i));
    slide.set(i);
    step.set(st);
    return { slide: i, step: st };
  };

  const goTo = (index: number): void => {
    goToFrame(index, 0);
  };

  const goForward = (): DeckFrame => {
    const f = frame();
    if (f.step < stepsOf(f.slide)) return goToFrame(f.slide, f.step + 1);
    if (f.slide < slides.length - 1) return goToFrame(f.slide + 1, 0);
    return f;
  };

  const goBack = (): DeckFrame => {
    const f = frame();
    if (f.step > 0) return goToFrame(f.slide, f.step - 1);
    if (f.slide > 0) return goToFrame(f.slide - 1, stepsOf(f.slide - 1));
    return f;
  };

  const stepAt = (index: number): number => {
    const current = slide.get();
    if (index < current) return stepsOf(index);
    if (index > current) return 0;
    return Math.min(step.get(), stepsOf(index));
  };

  const atStart = (): boolean => slide.get() === 0 && step.get() === 0;
  const atEnd = (): boolean =>
    slide.get() === slides.length - 1 && step.get() >= stepsOf(slides.length - 1);

  // Actions return what they WROTE, never a re-read: Solid batches writes, so
  // a same-tick read would lie (the standard-tools rule).
  const next = action({
    scope: s,
    name: "next",
    description:
      "Advance one step: play the current slide's next scene, or move to the " +
      "next slide once its scenes are spent (no-op at the very end).",
    run: () => goForward(),
  });

  const prev = action({
    scope: s,
    name: "prev",
    description:
      "One step back: un-play the current slide's last scene, or return to " +
      "the previous slide at its last scene (no-op at the very start).",
    run: () => goBack(),
  });

  return {
    scope: s,
    slides,
    slide,
    step,
    next,
    prev,
    count: slides.length,
    stepsOf,
    stepAt,
    atStart,
    atEnd,
    goTo,
    goToFrame,
    goForward,
    goBack,
  };
}
