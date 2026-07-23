/**
 * Landing.tsx — the site home: a card per demo, each with a LIVE preview.
 *
 * The whole card is a link to the demo (client-side navigation via the shell's
 * link interceptor — an open intent turn survives). The preview is the demo's
 * own `DemoCard.Preview`, lazily imported from its `./card` module (site
 * registry ← virtual:demo-pages). Cards are lightweight by contract, so
 * mounting all of them here does NOT boot any demo's heavy durable graph; each
 * preview manages its own tiny state and cancels its own rAF on unmount (when
 * the visitor leaves the landing and this tree is disposed).
 *
 * A demo that ships no `./card` (no `loadCard`) degrades to a preview-less
 * card — title, blurb (the sidebar `desc`), and the open affordance.
 */
import type { DemoCard } from "@habemus-papadum/aiui-viz";
import { createSignal, For, Show } from "solid-js";
import { DEMOS, type DemoPageEntry } from "./registry";
import { hrefOf } from "./router";

function DemoCardTile(props: { entry: DemoPageEntry }) {
  const [card, setCard] = createSignal<DemoCard>();
  // Kick off the (lazy, code-split) card import; store the resolved DemoCard.
  props.entry
    .loadCard?.()
    .then((m) => setCard(m.card))
    .catch((err) => console.error(`[gallery] card for "${props.entry.slug}" failed to load`, err));

  const blurb = () => card()?.blurb ?? props.entry.desc;

  return (
    <a class="demo-card" href={hrefOf(props.entry.slug)}>
      <div class="demo-card-preview">
        <Show
          when={card()?.Preview}
          fallback={
            props.entry.loadCard ? (
              <div class="demo-card-shimmer" />
            ) : (
              <div class="demo-card-blank" />
            )
          }
        >
          {/* Mount the demo's live preview component (self-contained). */}
          {(Preview) => Preview()({})}
        </Show>
      </div>
      <div class="demo-card-body">
        <div class="demo-card-title">{props.entry.title}</div>
        <p class="demo-card-blurb">{blurb()}</p>
        <span class="demo-card-open">
          open <span aria-hidden="true">→</span>
        </span>
      </div>
    </a>
  );
}

export function Landing() {
  return (
    <div class="landing">
      <header class="landing-head">
        <h1>
          aiui <span class="accent">notebooks</span>
        </h1>
        <p class="landing-lead">
          A gallery of interactive scientific notebooks, each built with aiui — SolidJS 2.0,
          Observable-style dataflow, and an agent tool surface. Open one, then talk to it: the
          intent client sends your words (and what you point at) into a live coding loop.
        </p>
      </header>
      <div class="demo-card-grid">
        <For each={DEMOS}>{(d) => <DemoCardTile entry={d} />}</For>
      </div>
    </div>
  );
}
