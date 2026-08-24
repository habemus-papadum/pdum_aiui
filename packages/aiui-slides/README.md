# `@habemus-papadum/aiui-slides`

A slides framework for aiui apps: a deck of viewport-sized slides where
**the current frame is a pair of controls** — durable, deep-linkable, and
drivable by keyboard, widget, wheel, touch, URL, or agent ("next", by voice,
through the derived tools).

- **Slides are data** — a deck is an ordered `SlideDef[]` (`id`, `title`,
  `content`, optional `preview` and `steps`); the URL segments, HUD grid,
  and nav all derive from the array.
- **Scenes** — a slide with `steps: n` plays n additive scenes inside itself
  before the deck moves on: components stay mounted and share the slide's
  reactive graph, a scene is a CSS state flip on `useSlide().step()` (the
  `Step` helper cans the idiom), and backing up un-plays them one by one.
- **Every input means one frame.** Wheel and touch are interpreted, not
  native: pure intent machines quantize a flick (inertia tail and all), a
  wheel notch, or one finger-down into exactly one step — the next scene,
  or the next slide once the scenes are spent. Keys, the cue, the dots, and
  the agent verbs dispatch the same unit.
- **`createDeckModel(scope, slides)`** declares the `slide` + `step`
  controls and the `next`/`prev` actions under your app's scope — one
  toolkit serves navigation and content.
- **`<Deck model={deck} basePath={deckBase("slug")} />`** renders the
  translated track (CSS glide between slides) and the chrome: the one-step
  cue (immediate on the title frame, back after 10 s of rest, flipping up at
  the very end), scene-position dots, nav widget, HUD overview grid (every
  slide's cheap pure `preview` at a glance — slide-grained, like the URL),
  modal-kit keymap, and slide ↔ URL binding (`replaceState`; slide 0 is the
  bare base).
- **`Lens`** — levels of detail for any page: inline trigger → hover peek →
  interactive detail overlay, folded into the page's own reactive graph.
- **`useSlide()`** — a slide's handle (`index`, `deck`, `active()`,
  `step()`); gate rAF loops on `active()` so off-screen slides park
  themselves.

Default styling is the opt-in stylesheet — retheme via the `--aiui-deck-*` /
`--aiui-lens-*` tokens or ship your own sheet against the same class names:

```ts
import "@habemus-papadum/aiui-slides/styles.css";
```

The reference deck is `demos/gear-talk` (the involute gear as a six-slide
talk); the decided design contract is `docs/proposals/slides.md` in the
[pdum_aiui](https://github.com/habemus-papadum/pdum_aiui) repo.
