# SPA navigation and turn continuity: threads that survive "page" changes

## Context

The web intent tool is mounted **per document**: the `aiuiDevOverlay()` Vite plugin injects a
mount script into every page the dev server serves, and each page load constructs a fresh,
independent overlay — its own widget, its own `Engine` (whose event log *is* the thread), its own
socket plumbing, its own session-bus connection. What connects the overlays on different pages is
only the channel server they all dial: threads land in the same Claude session, and the session
bus caches a couple of last-writer-wins slots (`armed`, `preview`) in the channel process.

The turn — the one piece of state the widget treats as precious — is client-owned. While a thread
is open, events stream to the channel so lowering can pre-warm, but a socket that drops without
`fin` is an **abandoned turn**: the channel discards its state and nothing reaches the Claude
session (`aiui-claude-channel/src/intent-v1.ts`). Recovery, where it exists, replays the
client-side log into a fresh socket. The recovery machinery (`turn-store.ts`) was built for
exactly one hazard — HMR/full-reload tearing the overlay down *under the same URL* — and it
enforces that scope with an exact-URL gate on its sessionStorage mirror.

Cross-page navigation was never in scope, and the failure mode is now well understood (traced in
the "live" session, 2026-07-10). Start a thread on one gallery page, enter tweak mode, click a
header link:

1. Tweak mode releases pointer/keyboard to the app, so the click is a real navigation. Nothing
   intercepts it — the overlay has no `pagehide`/`beforeunload` handling.
2. The document dies. Engine, event log, open websocket (server abandons the thread), shot
   pixels, mic/capture grants, ink — all gone.
3. The new page mounts a fresh overlay. `TurnStore.recover()` refuses the sessionStorage mirror
   because `mirror.url !== currentUrl()` (`turn-store.ts:114-128`). Fresh empty engine.
4. The session bus join snapshot then replays the hub-cached `armed: true` into the fresh engine
   (`modality.ts` bus wiring) — the new overlay comes up armed. State *appears* to have followed
   you; the transcript did not. Hence "mostly reset."
5. That very re-arm event runs the persistence listener with `threadOpen === false`, which calls
   `turn.clear()` (`modality.ts:1323-1327`) — deleting the *old page's* mirror from the shared
   per-tab sessionStorage. Navigating back recovers nothing, even though the URL now matches.

The deeper diagnosis: **turn continuity is currently an accident of DOM lifetime, not a property
of the session.** Whether a thread survives a "page" change depends on one binary — does the
document survive? — which is entirely a function of how the app navigates:

- **True client-side routing** (React Router, solid-router, TanStack, hash routing, raw
  `pushState`): the document survives, and with it the overlay, the engine, the open thread, the
  socket, the grants. The thread doesn't even notice. All routers in this class are equivalent —
  "same document" is their defining property.
- **Body-swapping transition frameworks** (Turbo/Hotwire, Astro ClientRouter, swup): the JS realm
  survives but big DOM chunks are replaced. Child swaps trigger the mount module's remount
  observer and the *soft-remount* recovery path (which, notably, has **no** URL gate — the
  in-memory `durable` copy is adopted regardless); body-*element* swaps orphan the observer
  (it's attached to the body node, `vite.ts:336`) and the overlay silently vanishes.
- **Hard navigation** (bare `<a href>`, `window.location`, `reloadDocument`): document death,
  the walk-through above, regardless of router brand.

This proposal makes regime 1 a supported, *traced* methodology, and names the gotchas.

## Proposal 1 — navigation events: the generic hook

Add a **navigation watcher** to the overlay's page instrumentation, beside the selection watcher
(`selection.ts`) and interaction watcher (`interaction.ts`):

- **Mechanism.** Prefer the Navigation API (`window.navigation`, `navigate` event) when present —
  it fires uniformly for `pushState`/`replaceState`/`popstate`/hash changes and link-driven
  same-document traversals, and the project's session-browser posture is Chromium-centric anyway.
  Fallback: patch `history.pushState`/`replaceState` and listen to `popstate` + `hashchange`.
  This is the same technique analytics SDKs use for SPA page tracking, and it is
  **router-agnostic by construction** — every client-side router bottoms out in these primitives.
  No per-framework adapters.
- **Event shape.** A structured `navigation` intent event (`{ from, to, at }`, plus whatever the
  Navigation API can cheaply attribute — `traverse` vs `push` vs `replace`). Emitted **only while
  a thread is open**, mirroring the `app-selection` rule: context riding a turn, never a turn
  opener.
- **Defer rendering to lowering.** The event travels structured; how a mid-turn navigation reads
  in the prompt is `composeIntent`/the channel's decision, not the watcher's. Ordering in the log
  gives attribution for free: strokes, shots, and selections *before* the navigation event belong
  to the old page, *after* it to the new one.
- **Fixes hello staleness.** The thread's `ClientMeta` snapshots `location.href` once at
  thread-open; navigation events make the stream self-describing afterwards, so the lowered
  prompt can say "started on morphogen, navigated to aztec, then circled *this*."
- **Ships unconditionally.** In an MPA the document dies before the watcher matters, so there is
  no risk in installing it everywhere.

## Proposal 2 — the SPA shell: pages as modules, one document

The methodology apps must opt into (an un-intercepted anchor cannot be rescued from the outside —
see gotcha #1). The key realization from the gallery: what's worth keeping about its authoring
model is *not* the separate HTML documents — it's that **each notebook is a self-contained module
added by one line in `nav.ts`**. That survives intact under a thin SPA shell:

- One `index.html`, one shell that owns `SiteHeader` and derives a route table from the same
  `TABS` config (hrefs become `/aztec` instead of `./aztec.html`).
- Each page stays an independent module (`src/pages/aztec/…`) the shell lazy-loads via dynamic
  `import()` on route change. Vite code-splitting keeps per-notebook bundles separate
  automatically — the isolation `rollupOptions.input` was buying, without the multi-entry build.
- Per-page `<title>` and the pre-paint theme stamp move into the shell. Adding a notebook is
  still "one TABS entry + one page module."
- **Router choice is almost immaterial** (that is Proposal 1's point). `@solidjs/router`
  compatibility with SolidJS 2.0 beta needs checking; the fallback is a ~30-line `pushState`
  router, genuinely sufficient for a flat tab list. A middle option: `navigation.intercept()`
  lets the platform be the router — real, deep-linkable URLs with no router dependency (the dev
  server then needs an SPA fallback rewrite).

Either way, the generic watcher captures it identically, and the whole per-document state model —
engine, thread, socket, grants, share, realtime session — survives navigation *by construction*
rather than by recovery.

## Gotchas

1. **The link is the escape hatch.** A single bare `<a href>` that the router doesn't intercept —
   or `window.location.href = …`, a form post, React Router's `reloadDocument` — is a hard
   navigation and the thread dies exactly as today. The navigation hook can *observe* client-side
   routing; it cannot *create* it. This is a path-of-least-resistance problem, not a runtime
   problem: the template and the frontend-design skill must make routed links the default idiom
   (e.g. the shell's `SiteHeader` renders router links, and the guidance says so), because
   agent-generated apps will copy whatever the scaffold demonstrates. A dev-mode nicety worth
   considering: the watcher can log (or toast) when a same-origin anchor hard-navigated a page
   that had an open thread — turning silent loss into a visible lesson.
2. **Ink must not outlive its page.** Strokes live on a full-viewport canvas and enter the log as
   geometry; under SPA navigation the pixels would float over the new page — deixis pointing at
   nothing. Policy: **clear on navigation** (the existing `inkCleared` with a navigation reason).
   Logged strokes remain as history, correctly attributed by ordering; screenshots stay the
   durable form of deixis (a shot freezes what "this" meant at capture time). Per-URL stroke
   layers (save/restore ink per navigation target) were considered and deliberately deferred:
   they fight ink's designed semantics — turn-scoped *gestures* with fade, not annotations — and
   no workflow demands them yet.
3. **App selections go stale.** An `app-selection` whose DOM died with the old route should be
   retracted (or explicitly left as pre-navigation history) at the boundary; the selection
   watcher won't reliably fire a clear on its own.
4. **Body-swap frameworks are out of scope.** Turbo/Astro-style HTML swapping is the worst of
   both worlds here: framework-specific DOM contracts, the body-node observer hazard, head/script
   re-execution semantics — and the soft-remount path would carry turns across "pages" with no
   URL discipline at all. Recommend against; don't engineer for it.
5. **The recovery gate needs rethinking once navigation is legitimate.** With in-turn navigation
   a first-class event, `TurnStore.recover()`'s exact-URL gate is the wrong scope for
   full-reload recovery ("same app" is righter), and the `turn.clear()`-on-fresh-page hazard
   (step 5 in Context) should be fixed regardless — a fresh mount shouldn't garbage-collect
   another page's mirror just because its own first event arrived with `threadOpen === false`.
6. **Small staleness leaks.** The session-bus hello snapshots `url`/`title` at join, so the peer
   list shows the route the tab joined on; the thread hello has the same issue (superseded by
   navigation events, per Proposal 1, but the peer list may deserve a refresh-on-navigate).
7. **The trace viewer should render the boundary.** A navigation event is cheap to display and
   immediately clarifying in the debug-ui transcript — worth doing in the same change that adds
   the event, so traces never contain events the viewer can't show.

## The demos are not examples to follow

This needs saying explicitly, because the demos are what agents (and readers) imitate:

- **`demos/gallery` is deliberately rigid Level-1 MPA** — three Vite entries
  (`vite.config.ts` `rollupOptions.input`), plain-anchor navigation
  (`src/site/nav.ts` hrefs like `./aztec.html`), a header whose "continuity" is an illusion
  (the same `SiteHeader` component recompiled into each entry and rebuilt from scratch on every
  document load, theme re-stamped per page). It predates this thinking. As a *notebook
  collection* it is fine; as a *navigation methodology* it is precisely the layout that makes
  turn continuity impossible, and nothing should scaffold from it (it already isn't a template —
  this proposal adds "don't imitate its page structure" to the reasons why).
- **The starter template (`packages/create-aiui/templates/app`) is a single document** with no
  navigation story at all — which means the SPA-shell methodology has no example anywhere in the
  repo today. When multi-page apps become a supported pattern, the template (or a fenced scenery
  variant of it) and the frontend-design skill are where the shell must appear, so that the
  path of least resistance for an agent asked to "add a second page" is a routed page module,
  not a second `.html` entry copied from the gallery.

## Sequencing

1. Navigation watcher + `navigation` event + ink-clear/selection policy + trace-viewer rendering
   (one change; unconditionally safe).
2. SPA shell in the gallery — both as the fix for its own lost-thread papercut and as the
   in-repo reference for the methodology; `nav.ts` stays the single source.
3. Template + frontend-design skill guidance (routed links as the default idiom; the "add a
   page" recipe).
4. Recovery-gate relaxation and the `turn.clear()` hazard fix (independent, small, worth doing
   even without 2–3).

## Open questions

- Should a navigation while **armed but with no open thread** do anything (arm carries over
  trivially since the document survives — but should it *open* a thread the way a contribution
  does)? Current lean: no — navigation is context, not content.
- Does the channel want navigation milestones in its trace timing (`intent-v1.ts` milestone
  list), or is the event log enough?
- How far to take the dev-mode hard-navigation warning (gotcha #1) — console, toast, or nothing?
- Per-URL ink layers if a real annotation workflow ever appears (explicitly deferred, not
  rejected forever).


## Outcome (2026-07-10) — proposals 1 and 2 shipped; recovery fixed

**Proposal 1 shipped** as `packages/aiui-dev-overlay/src/navigation.ts` plus wiring:

- The watcher prefers the Navigation API's `currententrychange` (one event per COMMITTED
  same-document navigation, with `navigationType`), falling back to pushState/replaceState
  patching + popstate/hashchange. Router-agnostic as designed; ships unconditionally.
- The `navigation` intent event landed as proposed (`{ from, to, kind? }`, emitted only while a
  thread is open — context, never a turn opener). `composeIntent` folds it as a positional
  boundary item and lowers it to a compact parenthetical; the trace viewer renders `⇢ from → to`;
  the preview shows a minimal `⇢ /route` chip.
- **Policy hinge discovered during build: `pathChanged`.** Not every same-document navigation is
  a page change — `replaceState` syncing app state into the query string and `#section` TOC
  jumps navigate without changing pathname. The destructive policies (ink clear, selection
  retraction) key on a PATHNAME change; same-path changes are traced but clear nothing.
- Ink policy: on a path change the canvas clears and the stream records
  `ink-clear { auto: true, reason: "navigation" }`; stale app selections retract through the
  host clearing the selection watcher (ordinary onChange → `app-selection-drop`), ordered after
  the navigation event.

**Proposal 2 shipped**: `demos/gallery` is now the single-document SPA reference.

- ~40-line pushState router (`src/site/router.ts`) over the `TABS` config; `@solidjs/router`
  was not risked against the Solid 2.0 beta, per the "almost immaterial" analysis.
- **Delegated link interception** answers gotcha #1 more strongly than the proposal asked:
  every same-origin, in-base anchor click app-wide becomes a client-side navigation
  (`interceptLocalLinks`), so the safe idiom is the default idiom — a prose link between
  notebooks can't kill a turn either. Modified clicks, targets, downloads, and external URLs
  pass through; same-path hash links stay native.
- **Pause-not-destroy page lifecycle** (`src/site/pages.ts`): a route change disposes the page's
  component tree (the HMR disposability, reused) and parks its rAF loops
  (`SimLoop.pause`/`Player.pause` — parking is distinct from the user-facing `speed=0` /
  `playing=false` controls), while durables survive. Event-driven resources (workers between
  jobs, DuckDB) needed nothing. This is the piece the proposal under-specified: routers dispose
  component trees, and the gallery's heavy resources are deliberately NOT in the component tree —
  the lifecycle seam had to be added by hand (~10 lines per page).
- Deep links: dev rides Vite's SPA fallback; the published static site gets explicit
  `aztec`/`seismos` objects (content-type text/html) plus `.html` twins so legacy inbound URLs
  keep working (`publish.sh`); the router maps `.html` slugs onto routes.
- **One window, merged registries — the open design question this rewrite surfaced.** Under one
  document, all pages' controls/cells/edges share the global reflection registries, so each
  page's `report` lists every page's surface. Names are unique across the gallery today (that is
  now a stated rule in each store's header) and durable keys are page-prefixed; whether the
  reflection layer wants first-class scoping (a `page`/`scope` field, per-kit filtered reports)
  is deferred until an app actually confuses an agent — recorded as a porcelain/possibility item
  in front_end_controls_guide_and_more.md.
- Found and fixed while converting: the gallery's vite config still had the pre-controls
  `locator: { cellFactories: ["cell"] }`, which suppresses control/action name injection (a
  Phase-3 adoption gap — nameless `control()` throws at runtime). Now `locator: true`.

**Gotcha #5 fixed** (both halves):

- `TurnStore.recover()` dropped the exact-URL gate: sessionStorage is already same-tab +
  same-origin (≈ "same app" under a dev server), freshness stays the bound, and `RecoveredTurn`
  now reports the URL the turn was last recorded on. When it differs from the adopting page, the
  modality records the hard navigation as a `navigation` event at adopt time — the boundary the
  watcher couldn't see (the document died first) is reconstructed in the stream.
- The `turn.clear()`-on-threadless-event hazard is gone: the mirror is forgotten only on an
  actual `thread-close`, so a fresh page's bus-replayed `armed` event no longer garbage-collects
  another page's recoverable turn.

**Still open** (unchanged from the proposal): the session-bus hello URL staleness for the peer
list (gotcha #6 — the thread side is superseded by navigation events); channel-side navigation
milestones in trace timing; the dev-mode hard-navigation warning (moot inside the gallery now
that links are intercepted, still interesting for arbitrary apps); per-URL ink layers (deferred);
sequencing step 3's template "add a page" recipe — the template is still single-page, and the
skill/playbook now describe the routed-shell idiom with the gallery as the reference.
