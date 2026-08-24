/**
 * deck.tsx — the deck runtime: a viewport-clipped column of slides over a
 * {@link DeckModel}, moved by ONE unit — the frame (a scene step, or a slide
 * once its scenes are spent) — plus the chrome (cue, dots, nav widget, HUD)
 * and the keymap. Everything here is a view/relay of the model's two frame
 * controls — the component owns NO navigation state except the HUD's open
 * flag (view chrome, deliberately not durable).
 *
 * ## Scroll is interpreted, never native
 *
 * The viewport is `overflow: hidden`; a TRACK inside it translates to
 * `-slide × 100%` and a CSS transition makes the glide (reduced motion turns
 * it off — styles.css). Wheel and touch input feed the pure intent machines
 * (gestures.ts): one gesture — a flick with its whole inertia tail, a wheel
 * notch, one finger-down — becomes exactly one `goForward()`/`goBack()`.
 * Native scrolling cannot express "this scroll plays a scene instead of
 * moving the page", so the deck owns the wheel; the price is the
 * GESTURE-HOLE rule below, which gives legitimately scrollable content its
 * scroll back. Keyboard, cue tap, dots, agent verbs — all dispatch the same
 * one-frame unit, so no input can blow past an unplayed scene. Slide-grained
 * jumps stay where they belong: HUD tiles, the URL, `set slide`.
 *
 * ## Gesture holes
 *
 * A wheel/touch event is NOT deck navigation when it lands inside: an open
 * Lens surface (`.aiui-lens-overlay` / `.aiui-lens-peek`), anything marked
 * `data-deck-scroll-hole`, or a scrollable region with travel left in the
 * gesture's direction. Those events pass untouched (no preventDefault) so
 * the content underneath scrolls normally.
 *
 * jsdom guards: everything here is plain listeners + inline styles, so the
 * whole runtime — gestures included — exercises headlessly.
 */
import { PageBoundary } from "@habemus-papadum/aiui-viz";
import { installKeys, resolveKey } from "@habemus-papadum/aiui-viz/modal";
import type { JSX } from "@solidjs/web";
import { createEffect, createSignal, For, getOwner, onCleanup, runWithOwner, Show } from "solid-js";
import { SlideContext } from "./deck-context";
import { DeckNav } from "./deck-nav";
import { createTouchIntent, createWheelIntent } from "./gestures";
import { DeckHud } from "./hud";
import { type DeckCommand, type DeckKeyState, deckKeyLayers } from "./keys";
import { LensLayer } from "./lens";
import type { DeckModel } from "./model";
import { bindDeckToPath } from "./path-binding";
import { ScrollCue } from "./scroll-cue";
import { StepDots } from "./step-dots";

/** Px per line/page for normalized wheel deltas (deltaMode 1/2). */
const LINE_PX = 24;

/** See "Gesture holes" above. `deltaY` null = direction unknown (touch):
 * any scrollable ancestor keeps its gesture. */
function inGestureHole(
  target: EventTarget | null,
  viewport: HTMLElement,
  deltaY: number | null,
): boolean {
  let el: Element | null = target instanceof Element ? target : null;
  while (el !== null && el !== viewport) {
    if (
      el.classList.contains("aiui-lens-overlay") ||
      el.classList.contains("aiui-lens-peek") ||
      (el instanceof HTMLElement && el.dataset.deckScrollHole !== undefined)
    ) {
      return true;
    }
    if (el instanceof HTMLElement && el.scrollHeight > el.clientHeight + 1) {
      const overflowY = getComputedStyle(el).overflowY;
      if (overflowY === "auto" || overflowY === "scroll") {
        if (deltaY === null) return true;
        if (deltaY > 0 && el.scrollTop + el.clientHeight < el.scrollHeight - 1) return true;
        if (deltaY < 0 && el.scrollTop > 0) return true;
      }
    }
    el = el.parentElement;
  }
  return false;
}

export function Deck(props: {
  model: DeckModel;
  /** Bind slides to the URL under this base path (see path-binding.ts;
   * compute it with `deckBase(slug)`). Omit for an unrouted deck. */
  basePath?: string;
  /** Set false to drop the bobbing one-step cue (scroll-cue.tsx). */
  cue?: boolean;
  /** Set false to drop the scene dots (step-dots.tsx). */
  dots?: boolean;
  /** Set false to drop the nav widget (keyboard/agent-only decks). */
  nav?: boolean;
  class?: string;
}): JSX.Element {
  const model = props.model;
  const [hudOpen, setHudOpen] = createSignal(false);

  if (props.basePath !== undefined) bindDeckToPath(model, props.basePath);

  // --- the keymap (modal kit: one capture owner, claim-or-pass layers) ------
  const layers = deckKeyLayers();
  const keyState = (): DeckKeyState => ({
    hudOpen: hudOpen(),
    atStart: model.atStart(),
    atEnd: model.atEnd(),
  });
  const dispatch = (command: DeckCommand): void => {
    switch (command) {
      case "next":
        model.goForward();
        break;
      case "prev":
        model.goBack();
        break;
      case "first":
        model.goToFrame(0, 0);
        break;
      case "last":
        model.goToFrame(model.count - 1, model.stepsOf(model.count - 1));
        break;
      case "toggle-hud":
        setHudOpen((open) => !open);
        break;
      case "close-hud":
        setHudOpen(false);
        break;
    }
  };
  if (typeof document !== "undefined") {
    onCleanup(installKeys({ stack: layers, getState: keyState, dispatch }));
  }
  /** A widget tap runs through the SAME resolver as a real keydown (the
   * tapKey house pattern) — a button can never drift from its key. */
  const tap = (key: string): void => {
    const claim = resolveKey(layers, keyState(), key, "down", false);
    if (claim !== "pass" && claim !== "swallow") dispatch(claim.command);
  };

  // --- gestures → frames ----------------------------------------------------
  // Captured HERE, in the component body: Solid 2.0 runs ref callbacks with
  // NO owner — getOwner() inside a ref is null, and an unowned onCleanup
  // never runs (NO_OWNER_CLEANUP; the listeners would leak).
  const owner = getOwner();

  const setupGestures = (viewport: HTMLElement): void => {
    const wheel = createWheelIntent();
    const touch = createTouchIntent();
    const stepBy = (dir: -1 | 1): void => {
      if (dir === 1) model.goForward();
      else model.goBack();
    };
    const onWheel = (e: WheelEvent): void => {
      if (inGestureHole(e.target, viewport, e.deltaY)) return;
      e.preventDefault();
      const scale = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? viewport.clientHeight : 1;
      const dir = wheel.feed(e.timeStamp, e.deltaY * scale);
      if (dir !== 0) stepBy(dir);
    };
    const onTouchStart = (e: TouchEvent): void => {
      if (e.touches.length === 1) touch.start(e.touches[0].clientY);
    };
    const onTouchMove = (e: TouchEvent): void => {
      if (e.touches.length !== 1) return; // pinch etc. stay the browser's
      if (inGestureHole(e.target, viewport, null)) return;
      e.preventDefault(); // the deck owns single-finger vertical travel
      const dir = touch.move(e.touches[0].clientY);
      if (dir !== 0) stepBy(dir);
    };
    const onTouchEnd = (): void => touch.end();
    viewport.addEventListener("wheel", onWheel, { passive: false });
    viewport.addEventListener("touchstart", onTouchStart, { passive: true });
    viewport.addEventListener("touchmove", onTouchMove, { passive: false });
    viewport.addEventListener("touchend", onTouchEnd, { passive: true });
    viewport.addEventListener("touchcancel", onTouchEnd, { passive: true });
    onCleanup(() => {
      viewport.removeEventListener("wheel", onWheel);
      viewport.removeEventListener("touchstart", onTouchStart);
      viewport.removeEventListener("touchmove", onTouchMove);
      viewport.removeEventListener("touchend", onTouchEnd);
      viewport.removeEventListener("touchcancel", onTouchEnd);
    });
  };

  // The lens layer: an untransformed sibling of the track, INSIDE the deck's
  // token scope. Lens popovers reparent here (lens.tsx, LensLayer) — on the
  // track every slide past the first is transform-translated, which would
  // become their fixed-position containing block and skew them off-viewport.
  const lensLayer = typeof document === "undefined" ? null : document.createElement("div");
  if (lensLayer !== null) lensLayer.className = "aiui-deck-layer";

  // Navigation drops focus left in SLIDE CONTENT: a clicked link or Lens
  // trigger stays focused after the frame moves — invisible, it would
  // re-fire on Enter, and the next keydown promotes it to a :focus-visible
  // ring (a phantom box around a link nobody is on). Deck chrome (nav,
  // dots, HUD) lives outside the track and keeps its focus.
  let trackEl: HTMLElement | undefined;
  if (typeof document !== "undefined") {
    createEffect(
      () => [model.slide.get(), model.step.get()],
      () => {
        const active = document.activeElement;
        if (
          trackEl !== undefined &&
          (active instanceof HTMLElement || active instanceof SVGElement) &&
          trackEl.contains(active)
        ) {
          active.blur();
        }
      },
    );
  }

  return (
    <div class={`aiui-deck${props.class === undefined ? "" : ` ${props.class}`}`}>
      <div
        class="aiui-deck-viewport"
        ref={(el) => {
          // Solid 2.0: no onMount — the ref runs when the element exists.
          // Re-enter the owner captured in the component body: the gesture
          // listeners' onCleanup must register there.
          runWithOwner(owner, () => setupGestures(el));
        }}
      >
        {/* The first render already carries the restored frame's transform,
            so a durable/deep-link mount lands there with no catch-up glide
            (transitions never run on initial style application). */}
        <div
          class="aiui-deck-track"
          style={{ transform: `translateY(-${model.slide.get() * 100}%)` }}
          ref={(el) => {
            trackEl = el;
          }}
        >
          {/* Slides are STATIC data (a deck never reorders), so the index is
              zipped in as a plain value — refs and the provider value read no
              accessors (STRICT_READ_UNTRACKED stays quiet, correctly). */}
          <For each={model.slides.map((def, index) => ({ def, index }))}>
            {({ def, index }) => (
              <section
                class="aiui-deck-slide"
                data-index={index}
                data-slide-id={def.id}
                data-step={model.stepAt(index)}
                aria-label={`slide ${index + 1} of ${model.count}: ${def.title}`}
              >
                {/* Solid 2.0: the context object IS the provider component.
                    Both providers sit BELOW the For — a For row does not see
                    context provided above it (probed on beta.32). */}
                <LensLayer value={lensLayer}>
                  <SlideContext
                    value={{
                      deck: model,
                      index,
                      active: () => model.slide.get() === index,
                      step: () => model.stepAt(index),
                    }}
                  >
                    {/* One broken slide must not halt a live talk: boundary per
                      mount seam (the gallery's per-page rule, per-slide). */}
                    <PageBoundary name={def.title}>
                      <def.content />
                    </PageBoundary>
                  </SlideContext>
                </LensLayer>
              </section>
            )}
          </For>
        </div>
      </div>
      {lensLayer}
      <Show when={props.cue !== false}>
        <ScrollCue model={model} />
      </Show>
      <Show when={props.dots !== false}>
        <StepDots model={model} />
      </Show>
      <Show when={props.nav !== false}>
        <DeckNav model={model} state={keyState} tap={tap} />
      </Show>
      <Show when={hudOpen()}>
        <DeckHud model={model} close={() => setHudOpen(false)} />
      </Show>
    </div>
  );
}
