/**
 * hud.tsx — the heads-up display: every slide at a glance, navigable by
 * tap/click/Enter. A dialog overlay (role="dialog", aria-modal) over the
 * deck, showing a responsive grid of tiles — the slide's `preview` mounted
 * LIVE when it ships one (the DemoCard discipline: cheap, pure-model, mounted
 * only while the HUD is open, disposed on close), a typographic tile
 * otherwise. The current slide is highlighted and receives focus on open, so
 * keyboard users land where they are.
 *
 * Deliberately a PROJECTION, not a mode: the deck's movement keys keep
 * working underneath (the HUD key layer passes them — keys.ts), and the
 * highlight follows. Escape and the backdrop close; choosing a tile
 * navigates and closes.
 */
import { PageBoundary } from "@habemus-papadum/aiui-viz";
import type { JSX } from "@solidjs/web";
import { For, Show, untrack } from "solid-js";
import type { DeckModel } from "./model";

export function DeckHud(props: { model: DeckModel; close: () => void }): JSX.Element {
  const current = (): number => props.model.slide.get();
  return (
    <div class="aiui-deck-hud" role="dialog" aria-modal="true" aria-label="slide overview">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the backdrop is a click-away surface; Escape (keys.ts) is the keyboard path. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: same — Escape is the keyboard equivalent, claimed by the HUD key layer. */}
      <div class="aiui-deck-hud-backdrop" onClick={() => props.close()} />
      <div class="aiui-deck-hud-grid">
        {/* Index zipped in as a plain value (static list) — no accessor reads
            in refs/handlers, so STRICT_READ_UNTRACKED stays quiet. */}
        <For each={props.model.slides.map((def, index) => ({ def, index }))}>
          {({ def, index }) => (
            <button
              type="button"
              class={`aiui-deck-hud-tile${current() === index ? " is-current" : ""}`}
              aria-label={`go to slide ${index + 1}: ${def.title}`}
              aria-current={current() === index ? "true" : "false"}
              ref={(el) => {
                // Land focus where the deck is (Solid 2.0: no onMount — the
                // ref runs when the element exists; defer past insertion).
                // A one-shot read by intent: focus follows open, not slide.
                if (untrack(() => props.model.slide.get()) === index) {
                  queueMicrotask(() => el.focus());
                }
              }}
              onClick={() => {
                props.model.goTo(index);
                props.close();
              }}
            >
              <div class="aiui-deck-hud-thumb">
                <Show
                  when={def.preview}
                  fallback={<div class="aiui-deck-hud-typo">{index + 1}</div>}
                >
                  {/* The lazy-getter pattern (gallery Landing.tsx): Show's
                      children run untracked, and PageBoundary both fixes the
                      read and contains a faulty preview to its tile. */}
                  {(Preview) => (
                    <PageBoundary name={`${def.title} preview`}>{Preview()({})}</PageBoundary>
                  )}
                </Show>
              </div>
              <div class="aiui-deck-hud-caption">
                <span class="aiui-deck-hud-num">{index + 1}</span>
                <span class="aiui-deck-hud-title">{def.title}</span>
              </div>
            </button>
          )}
        </For>
      </div>
    </div>
  );
}
