# A slides framework for aiui — decks, the HUD, and the Lens

Status: **accepted and implemented** — `packages/aiui-slides` (@habemus-papadum/aiui-slides;
incubated as `demos/slides`, promoted 2026-08-15 when the first out-of-repo consumer arrived —
an app must not depend on a demo),
`demos/gear-talk` (the reference deck), aiui-viz's `site/path.ts`, and the gallery's head/tail
routes all landed together with this document (this document is the decided contract; it
retires to git history once the dust has settled — the house convention for finished
proposals).

## What this is

A way to build a **deck of slides** as an ordinary aiui app: SolidJS components, controls and
cells under a scope, agent tools derived from declarations — just presented one viewport at a
time. The deck is not a new kind of thing; it is a `SitePage` whose App is a vertical
scroll-snap column of viewport-sized slides, whose **current slide is a control** in the deck's
scoped graph, and whose navigation chrome — cue, widget, HUD, keymap, URL — are all pure
views/relays of that one value. Every lifecycle here is one the repo already has.

Slides are **strictly linear** — a sequence, never a tree. A slide's *internal* structure
(progressive disclosure, overlays, the Lens below) is its own business and invisible to the
deck: the deck knows only an ordered list of slides.

Because a deck is web-native, it can serve **levels of detail** that paper slides cannot: the
top level stays high-level and visual; hover an annotated element for a dense intermediate
preview; click for a full, still-interactive detail view that remains folded into the page's
computational graph. That component (the **Lens**) is deliberately deck-independent — research
notebooks want it too.

## The pieces

### 1. `aiui-viz/site/path.ts` — one source of truth for location (upstream, now)

Both the gallery shell and a deck need to read and write `location.pathname` without fighting.
Events won't compose two routers; a shared reactive signal will:

- `pathname()` — a Solid signal of `location.pathname`, updated by a module-level `popstate`
  listener and by `navigateTo`.
- `navigateTo(path, { replace? })` — pushState/replaceState + signal update; same-path is a
  no-op.

No `import.meta.env` reads (dist code can never see a consumer's env — the packaging rule), no
base assumptions: bases belong to the consumers. The gallery router derives `route()` from
`pathname()`; a deck's path binding derives its slide from the same signal. Two writers, one
reactive source — nothing can drift.

### 2. Gallery router: head/tail routes

`route()` now carries the **full relative path** (`"gear-talk/mesh"`); the shell keys page
identity on the **head** segment, so a tail change never remounts the deck. `routeOf` keeps the
tail when the head is a known slug and still falls back to the landing otherwise. Without this,
`interceptLocalLinks` would swallow a deck-internal anchor: preventDefault, map `/talk/3` to
route `"talk"`, hit the same-route no-op — click eaten. With it, in-deck anchors, sidebar links,
and cross-demo links all keep working through the one interceptor.

The sidebar highlights by head; `loadPage` caches by head; `show()` early-returns when the head
is unchanged.

### 3. `packages/aiui-slides` — `@habemus-papadum/aiui-slides` (internal, never published)

The framework package, incubated exactly like `demos/journal` (as `demos/slides`; now under
packages/): workspace-internal, version lockstep, CI-typechecked, no `publishConfig`. Contents:

- **`SlideDef`** — `{ id, title, content: Component, preview?: Component }`. Slides are DATA
  (the router's "routes are data" move): the HUD grid, the URL segments, and any future
  overview all derive from the array, never from JSX introspection. `preview` is the DemoCard
  discipline at slide scale: a cheap, self-contained mini-view (pure model only, no durable
  graph) that the HUD can mount nine-at-a-time.
- **`createDeckModel(scope, slides)`** — the deck's durable side: a `slide` control
  (`min: 0, max: n-1, step: 1`, **explicit name** — the factory must not depend on the aiui
  compiler) plus `next`/`prev` actions under the deck's scope. Consequence: the deck is
  voice-drivable through the intent client for free (`set slide`, `gear-talk/next`), readable in
  `report`, durable across HMR. Views are pure readers.
- **`Deck`** — the component: an internal scroll container (`overflow-y: auto;
  scroll-snap-type: y mandatory`; never document scroll, so it composes under the gallery shell
  and SiteNav stays usable), one `<section>` per slide, each wrapped in its own `PageBoundary`
  (one broken slide must not halt a live talk). An IntersectionObserver reports which slide owns
  the viewport; a **scroll-intent guard** keeps the two writers honest: when navigation
  initiates a smooth scroll, a `scrollTarget` is set and the observer's intermediate readings
  don't write the model until the target arrives (user input — wheel/touch/pointer — cancels the
  claim). Slide content can ask `useSlide()` for its index and an `active()` accessor to park
  rAF work off-screen — pause-not-destroy at slide granularity, strictly opt-in.
- **Keymap via the modal kit** — one base layer (`↓`/`→`/`PageDown`/`Space` next; `↑`/`←`/
  `PageUp` prev; `Home`/`End`; `o` overview) plus a HUD layer that claims `Escape` while open,
  through `installKeys` — typing targets yield, claim-or-pass is exhaustive by construction.
  Escape is **not** the HUD opener (Esc means dismiss on the modal ladder; overloading it to
  open would fight the Lens and any future mode).
- **`DeckNav`** — the widget, because **a keyboard is never assumed**: prev/next chevrons
  flanking a "3 / 6" counter; tapping the counter opens the HUD. Buttons execute by synthesizing
  their binding's `tapKey` through the **same `resolveKey` stack** real keydowns use, and their
  labels come from the bindings' `KeyHint`s — the house pattern: a tap can never drift from what
  the key does, and the displayed keymap is the working keymap. Ships default styling
  (`aiui-deck-*` classes, CSS-custom-property tokens with fallbacks) in an opt-in stylesheet
  (`@habemus-papadum/aiui-slides/styles.css`) so a design system can retheme by setting
  variables or replacing the sheet — a middle course between aiui-viz's ship-no-styles rule and
  journal's ship-the-identity rule, chosen deliberately: a deck should look presentable with one
  import and be fully restylable without fighting specificity.
- **`DeckHud`** — the heads-up display: a dialog overlay (role="dialog", aria-modal) with a
  responsive grid of slide tiles — `preview` mounted live when the slide ships one, a typographic
  title tile otherwise; the current slide highlighted; click/tap/Enter navigates and closes;
  Escape or backdrop closes. Arrow keys deliberately still drive the deck while the HUD is open
  (the HUD layer passes them): the HUD is a *projection* of the deck, and the highlight follows.
  Previews mount only while the HUD is open and dispose on close.
- **`ScrollCue`** — the fai-canteen bob, adopted: a circled chevron pinned bottom-center,
  bobbing only under `prefers-reduced-motion: no-preference`, visible on the first slide and
  fading once you move (CSS owns the fade; the component only flips a class). Clicking it
  advances — it is a button, not just an ornament.
- **`bindDeckToPath(model, { base })`** — slide ↔ URL: slide 0 is the bare base (`/gear-talk`),
  every other slide is `base/<id>` (`/gear-talk/mesh`; a bare 1-based number is accepted
  inbound). Writes use **replaceState** — scrolling through a deck must not spam history; Back
  leaves the deck, like scrolling a long document. Reads are reactive over `pathname()`, so
  pasted links, popstate, and shell navigations all converge through equality guards — no loops,
  no second router.
- **`Lens`** — the three-tier detail component, **deck-independent by construction** (no deck
  imports, no deck context, no new dependencies — viewport clamping is a few lines, not a
  floating-ui dependency):
  - *Tier 1*: an inline trigger — a real `<button>` with a dotted-underline affordance,
    arbitrary JSX inside.
  - *Tier 2*: hover/focus (short delay) → an anchored popover rendering `preview` — dense,
    glanceable, DemoCard-cheap. Touch devices have no hover: tap goes straight to tier 3, by
    design, not simulation.
  - *Tier 3*: click → a centered overlay panel rendering `detail` — full, interactive, and **in
    the same reactive graph**: the overlay renders IN PLACE (`position: fixed`, no portal), so
    Solid ownership stays under the parent AND the page's design tokens reach it by CSS
    inheritance — a body-mounted portal would escape the page's token scope (found during
    implementation; `position: fixed` already escapes ancestor overflow clipping on its own,
    and the one caveat — a transformed ancestor becomes a fixed-position containing block — is
    a documented constraint on page CSS). Mount-on-open / dispose-on-close is the
    components-are-pure-readers discipline, so nothing is lost on close. Esc and
    outside-pointerdown close (Dropdown's conventions, its own listeners — the deck keymap runs
    in document capture, so an open HUD closes first: a coherent ladder).
  - Upstream target: `aiui-viz` (probably a `./lens` subpath) once it has survived the deck
    *and* one research notebook. When that lands, remember the packaging rules: the subpath goes
    in dev `exports` **and** `publishConfig.exports` with a trailing `"default"` condition, plus
    `pnpm test:packaging`.

### 4. `demos/gear-talk` — the reference deck

A real talk ("The Involute Gear", ~6 slides) that keeps the framework honest, riding
`demos/gears`' **pure geometry** (`gearGeometry`, `meshGeometry`, `toPathD` from its barrel —
never its store or graph: importing another app's durable identity is exactly the
cross-pollination scopes exist to prevent). It declares its own few controls under
`scope("gear-talk")`, registers standard tools (`toolsNs: "gear-talk"`), carries the
`aiui.sitePage` marker + a live landing card, and runs standalone (`pnpm -C demos/gear-talk
dev`) and in the gallery like every demo. It exercises everything: Lens tiers on real content, a
control moved inside one slide's Lens detail visibly persisting in a later slide's figure (the
"folded into the graph" claim made checkable), slide previews in the HUD, an rAF slide parking
itself via `useSlide().active`, and a cross-demo link to `/gears` through the interceptor.

## Decided details and traps

- **Two writers of the slide, one guard.** The observer (user scrolling) and the model
  (keys/widget/agent/URL) both move `slide`; the `scrollTarget` claim plus user-input
  cancellation is the whole protocol. Do not add flags beyond it.
- **replaceState, not pushState**, for slide changes. Deep links stay copyable at every moment;
  history stays sane.
- **Published-site deep links to slides are a known gap**: publish.sh ships explicit S3 objects
  per *demo* route; `/gear-talk/mesh` has no object and 404s on the static host (dev and any
  SPA-fallback host are fine, and `/gear-talk` itself works). Acceptable for v1; the escape
  hatch, if it ever matters, is a marker field listing slide ids for publish.sh to copy.
- **Viewport sizing** is the deck container's (`height: 100dvh` by default, overridable via
  `--aiui-deck-height`) — never `100vh` literals in slides, and never document scroll.
- **Reduced motion** gates the cue's bob (CSS) and smooth scrolling (`behavior: "auto"`)
  — both, always.
- **jsdom guards**: `IntersectionObserver` and `scrollIntoView` don't exist there; the deck
  feature-checks both so model/keymap tests run headless.
- **Solid 2.0-beta.32**: two-arg `createEffect` everywhere; `PageBoundary` at every mount seam
  that hosts foreign content (slides, HUD previews, Lens details).

## Non-goals (v1, named so nobody gets ambitious)

PDF/print export; presenter notes / speaker view; slide transitions beyond scroll; fragments /
per-bullet stepping (a slide's internal structure is its own — use Solid state, or a Lens);
lens-state-in-URL; a `new-deck` scaffolder (copy gear-talk until a third deck exists).

## Upstreaming path

1. `site/path.ts` — lands in aiui-viz now (this proposal).
2. `Lens` — moves to aiui-viz after proving out in the deck and one notebook page.
3. Deck chrome (`Deck`/`DeckNav`/`DeckHud`/`ScrollCue`) — stays incubating in
   `@habemus-papadum/aiui-slides` until a second deck exists; then either `aiui-viz/site` or a
   published `aiui-slides`, decided then. One consumer is an incubator, not a library.
