# `@habemus-papadum/aiui-slides`

A slides framework for aiui apps: a deck of viewport-sized, scroll-snapped
slides where **the current slide is a control** — durable, deep-linkable,
and drivable by keyboard, widget, scroll, URL, or agent ("next slide", by
voice, through the derived tools).

- **Slides are data** — a deck is an ordered `SlideDef[]` (`id`, `title`,
  `content`, optional `preview`); the URL segments, HUD grid, and nav all
  derive from the array.
- **`createDeckModel(scope, slides)`** declares the `slide` control and the
  `next`/`prev` actions under your app's scope — one toolkit serves
  navigation and content.
- **`<Deck model={deck} basePath={deckBase("slug")} />`** renders the
  scroll-snap column and the chrome: scroll cue, nav widget, HUD overview
  grid (every slide's cheap pure `preview` at a glance), modal-kit keymap,
  and slide ↔ URL binding (`replaceState`; slide 0 is the bare base).
- **`Lens`** — levels of detail for any page: inline trigger → hover peek →
  interactive detail overlay, folded into the page's own reactive graph.
- **`useSlide()`** — a slide's handle (`index`, `deck`, `active()`); gate
  rAF loops on `active()` so off-screen slides park themselves.

Default styling is the opt-in stylesheet — retheme via the `--aiui-deck-*` /
`--aiui-lens-*` tokens or ship your own sheet against the same class names:

```ts
import "@habemus-papadum/aiui-slides/styles.css";
```

The reference deck is `demos/gear-talk` (the involute gear as a six-slide
talk); the decided design contract is `docs/proposals/slides.md` in the
[pdum_aiui](https://github.com/habemus-papadum/pdum_aiui) repo.
