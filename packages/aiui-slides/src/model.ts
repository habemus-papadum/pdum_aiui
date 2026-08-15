/**
 * model.ts — the deck's durable side: **the current slide is a control**, not
 * component state.
 *
 * Registering `slide` (plus `next`/`prev` actions) under the deck's scope is
 * what makes a deck an aiui app rather than a widget: the agent's derived
 * tools can read it in `report`, move it with `set` ("go to slide 4") or the
 * verbs ("next slide" — the voice-drivable presentation), it survives HMR
 * like every control, and every piece of chrome — keymap, nav widget, HUD,
 * scroll cue, URL binding — is a pure view/relay of this one value.
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
import type { SlideDef } from "./types";

/** A deck's model: the slides (static data) + the current-slide control. */
export interface DeckModel {
  /** The deck's instance scope — also the natural `toolsNs` for its page. */
  scope: Scope;
  slides: readonly SlideDef[];
  /** Current slide index (0-based) — the one durable navigation fact. */
  slide: ControlBox<number>;
  next: RegisteredAction;
  prev: RegisteredAction;
  /** Clamped write (the control's own min/max validation does the clamping). */
  goTo(index: number): void;
  count: number;
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
  }

  const slide = control({
    scope: s,
    name: "slide",
    description:
      "Current slide (0-based). The deck scrolls to whatever this is set to; " +
      `slides in order: ${slides.map((d, i) => `${i}=${d.id}`).join(", ")}.`,
    value: 0,
    min: 0,
    max: slides.length - 1,
    step: 1,
  });

  const goTo = (index: number): void => {
    slide.set(index); // out-of-range writes are clamped by the control's meta
  };

  // Actions return what they WROTE, never a re-read: Solid batches writes, so
  // a same-tick read would lie (the standard-tools rule).
  const next = action({
    scope: s,
    name: "next",
    description: "Advance the deck one slide (no-op on the last slide).",
    run: () => {
      const target = Math.min(slide.get() + 1, slides.length - 1);
      goTo(target);
      return { slide: target };
    },
  });

  const prev = action({
    scope: s,
    name: "prev",
    description: "Go back one slide (no-op on the first slide).",
    run: () => {
      const target = Math.max(slide.get() - 1, 0);
      goTo(target);
      return { slide: target };
    },
  });

  return { scope: s, slides, slide, next, prev, goTo, count: slides.length };
}
