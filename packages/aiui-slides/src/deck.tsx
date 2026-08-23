/**
 * deck.tsx — the deck runtime: a vertical scroll-snap column of
 * viewport-sized slides over a {@link DeckModel}, plus the chrome (cue, nav
 * widget, HUD) and the keymap. Everything here is a view/relay of the model's
 * `slide` control — the component owns NO navigation state except the HUD's
 * open flag (view chrome, deliberately not durable).
 *
 * The deck owns an INTERNAL scroll container — never document scroll — so it
 * composes under a site shell (the sidebar stays usable, the shell's
 * scroll-to-top on navigate is harmless) and sizes itself via
 * `--aiui-deck-height` (default 100dvh).
 *
 * ## Two writers of `slide`, one guard
 *
 * The IntersectionObserver (the user scrolling) and the model (keys, widget,
 * agent, URL) both move the current slide. The protocol:
 *
 *  - the observer reports the slide owning the viewport → `viewIndex`; when
 *    that differs from the model, the USER scrolled — write the model.
 *  - a model change that does NOT match `viewIndex` initiates a programmatic
 *    scroll and claims `scrollTarget`; while claimed, the observer's
 *    intermediate readings (a smooth scroll sweeps past slides) are ignored
 *    until the target arrives — otherwise they would overwrite the intent
 *    mid-flight.
 *  - any user input (wheel / touch / pointer) cancels the claim: the user
 *    always wins an argument with an animation.
 *
 * Do not add flags beyond these two; every extra bit here is a future
 * deadlock (the proposal records this as the whole protocol).
 *
 * jsdom guards: IntersectionObserver and scrollIntoView don't exist there —
 * both are feature-checked so headless tests exercise model + keymap + chrome.
 */
import { PageBoundary } from "@habemus-papadum/aiui-viz";
import { installKeys, resolveKey } from "@habemus-papadum/aiui-viz/modal";
import type { JSX } from "@solidjs/web";
import {
  createEffect,
  createSignal,
  For,
  getOwner,
  onCleanup,
  runWithOwner,
  Show,
  untrack,
} from "solid-js";
import { SlideContext } from "./deck-context";
import { DeckNav } from "./deck-nav";
import { DeckHud } from "./hud";
import { type DeckCommand, type DeckKeyState, deckKeyLayers } from "./keys";
import type { DeckModel } from "./model";
import { bindDeckToPath } from "./path-binding";
import { ScrollCue } from "./scroll-cue";

export function Deck(props: {
  model: DeckModel;
  /** Bind slides to the URL under this base path (see path-binding.ts;
   * compute it with `deckBase(slug)`). Omit for an unrouted deck. */
  basePath?: string;
  /** Set false to drop the title slide's bobbing cue. */
  cue?: boolean;
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
    slide: model.slide.get(),
    count: model.count,
  });
  const dispatch = (command: DeckCommand): void => {
    switch (command) {
      case "next":
        model.goTo(untrack(() => model.slide.get()) + 1);
        break;
      case "prev":
        model.goTo(untrack(() => model.slide.get()) - 1);
        break;
      case "first":
        model.goTo(0);
        break;
      case "last":
        model.goTo(model.count - 1);
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

  // --- scroll ↔ model -------------------------------------------------------
  const slideEls: (HTMLElement | undefined)[] = [];
  let viewIndex = 0; // the observer's last confirmed owner of the viewport
  let scrollTarget: number | null = null; // a programmatic scroll's claim

  const reducedMotion = (): boolean =>
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Captured HERE, in the component body: Solid 2.0 runs ref callbacks (and
  // their microtasks) with NO owner — getOwner() inside a ref is null, and an
  // unowned onCleanup never runs (NO_OWNER_CLEANUP; the observer would leak).
  const owner = getOwner();

  const setupObserver = (container: HTMLElement): void => {
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const raw = (entry.target as HTMLElement).dataset.index;
          if (raw === undefined) continue;
          const index = Number.parseInt(raw, 10);
          if (scrollTarget !== null) {
            // Mid-programmatic-scroll: only the destination may report.
            if (index === scrollTarget) {
              scrollTarget = null;
              viewIndex = index;
            }
            continue;
          }
          viewIndex = index;
          if (untrack(() => model.slide.get()) !== index) model.goTo(index);
        }
      },
      // 0.6: a slide owns the viewport once it holds a clear majority of it —
      // mandatory snap means every rest state passes this comfortably.
      { root: container, threshold: 0.6 },
    );
    for (const el of slideEls) {
      if (el) observer.observe(el);
    }
    onCleanup(() => observer.disconnect());

    // The user always wins an argument with an animation.
    const cancel = (): void => {
      scrollTarget = null;
    };
    container.addEventListener("wheel", cancel, { passive: true });
    container.addEventListener("touchstart", cancel, { passive: true });
    container.addEventListener("pointerdown", cancel, { passive: true });
    onCleanup(() => {
      container.removeEventListener("wheel", cancel);
      container.removeEventListener("touchstart", cancel);
      container.removeEventListener("pointerdown", cancel);
    });
  };

  // Model → scroll: whenever `slide` moves away from what the viewport shows
  // (keys, widget, agent tool, URL, durable restore), bring it into view.
  // The first run is a RESTORE (deep link / durable state), not a gesture —
  // jump, don't glide.
  let firstScroll = true;
  createEffect(
    () => model.slide.get(),
    (index) => {
      const instant = firstScroll;
      firstScroll = false;
      if (index === viewIndex) return;
      scrollTarget = index;
      slideEls[index]?.scrollIntoView?.({
        behavior: instant || reducedMotion() ? "auto" : "smooth",
        block: "start",
      });
    },
  );

  return (
    <div class={`aiui-deck${props.class === undefined ? "" : ` ${props.class}`}`}>
      <div
        class="aiui-deck-scroll"
        ref={(el) => {
          // Solid 2.0: no onMount — the ref runs when the element exists;
          // defer a microtask so the slide sections below are inserted first
          // (the TocRail precedent). Re-enter the owner captured in the
          // component body: setupObserver's onCleanups must register there.
          queueMicrotask(() => runWithOwner(owner, () => setupObserver(el)));
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
              aria-label={`slide ${index + 1} of ${model.count}: ${def.title}`}
              ref={(el) => {
                slideEls[index] = el;
              }}
            >
              {/* Solid 2.0: the context object IS the provider component. */}
              <SlideContext
                value={{ deck: model, index, active: () => model.slide.get() === index }}
              >
                {/* One broken slide must not halt a live talk: boundary per
                    mount seam (the gallery's per-page rule, per-slide). */}
                <PageBoundary name={def.title}>
                  <def.content />
                </PageBoundary>
              </SlideContext>
            </section>
          )}
        </For>
      </div>
      <Show when={props.cue !== false}>
        <ScrollCue model={model} />
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
