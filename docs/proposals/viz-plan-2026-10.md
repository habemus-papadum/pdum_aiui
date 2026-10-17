# aiui-viz and its sister packages — the plan for October 2026

**Status:** in progress (opened 2026-10-17). Each item carries its own status: `planned`,
`in progress`, `done <sha>`, `dropped`. Agents landing an item update its line. Delete this file
when every item is done or dropped; git history is the record.

The catalog ([`packages/aiui-viz/CATALOG.md`](../../packages/aiui-viz/CATALOG.md)) says what the
package provides. This file says what happens to it next: a housekeeping pass, four pieces of work
done now, and a list of things noted and deliberately deferred. The decisions behind the list were
taken on 2026-10-17 and are stated inline so nobody re-derives them.

## The stance

- Everything is pre-alpha. No backward-compatibility work, no deprecation shims; consumers fix
  their own breakage.
- Scaffolding gets replaced, not patched: a new piece is written from scratch and the old one
  retired.
- Build in the main package. Improve an existing piece rather than paper over its shortcomings;
  reuse and improve rather than copy. There are few downstream users, so move fast.
- `packages/internal/` is for packages with a **replacement in mind**, not for packages that happen
  to be niche. aiui-stt, aiui-audio, aiui-screen-capture and aiui-cf-creds stay public.

## Housekeeping — first, in order

### H1 — commit the catalog demo — `done 21693dc6`

`demos/catalog` (the catalog rendered live), its README row, the CATALOG.md intro line, the
lockfile. Nothing to decide; it was verified end to end on 2026-10-16.

### H2 — the resize seam — `done 75c0ee84`

Observable's baked-in reactive values are `width` (the **main column's** width, not the window's),
`now` (the time, ticking per animation frame while something reads it), `dark` (the color scheme),
and per-element width through a resize generator. aiui has the `dark` half already:
`colorMode()` in `src/site/color-mode.ts` is a framework-level durable under the key
`aiui:color-mode`. It has nothing for width: nine ad-hoc `ResizeObserver`s sit in lens, rich-tex,
mermaid, embedding-view, pencil, the prompts inspector, screen-capture and the holograms/optics
demos, and `PlotFigure` has no width awareness at all (Plot's 640px default).

Deliverable: a design note (`packages/aiui-viz/docs/viewport.md`, or a section of
`frontend-design-choices.md` if it is short), one core module exporting page `width`/`height`, a
per-element size signal over one shared observer, and a subscriber-gated `now`; `PlotFigure` adopts
the element signal. The other observers migrate later (deferred list).

Constraints from the owner (2026-10-17): these are framework-level values, and nothing in the repo
keeps framework-level signals today except `colorMode` — follow its pattern or argue for a plainer
one (a module-level Solid signal may be enough). They must do the right thing under hot reload (one
listener, no reset mid-session) and must not confuse any registry: no duplicate entries from
composition, and ideally they sit in no registry at all. The durable registry is keyed and never
enumerated, which is why `colorMode`'s pattern is acceptable; the control/tool registry IS
enumerated (`report`) and these values do not belong in it.

### H3 — scaffolding and creds — `done 61d2dd65`

- The root `package.json` gains a `repository` field so `pnpm new-demo` stamps a real URL (today it
  writes `""`; styleguide and catalog have the URL by hand).
- The create-aiui template drops the voice dock (import, element, dependency, prose). In-repo demos
  keep it: `scripts/new-demo.ts` injects the dock with its anchored-replacement pattern.
  `pnpm test:template` and `pnpm test:packaging` stay green.
- aiui-cf-creds stays public and stops depending on aiui-oracle. Its `./oracle` subpath becomes
  `./openai`: the federated OpenAI key source, typed structurally so the oracle's `KeySource` is
  satisfied by shape. The oracle moves inward later (C); a public package must not depend on it.
  In-repo consumers update.

## Now — in parallel, after housekeeping

### A — hover notes and knobs, then Mermaid cleanup — `in progress`

One agent, because both live in `src/site/rich-tex.tsx` and `src/site/mermaid.tsx`. First: one
shared knob gesture (drag over a numeric control's range, arrow-key step, readout, `data-control`
attribution) and one shared notes layer (anchor, side, collision shifts, leaders), consumed by both.
Then the Mermaid cleanup before it has many users: the `wrappingWidth` default that clips labels,
the Mermaid theme and the RichTeX/Mermaid skins promoted into aiui-design (the catalog demo is the
second copy of the lab's), and the open items in `docs/proposals/rich-mermaid.md`.

### B — modal kit code review — `in progress` (report read 2026-10-17; approved: split and trim + a retirement record in packages/aiui-viz/docs/mode-engine.md)

A read-only report on `src/modal/*` and `src/mode-solid.ts` against the four consumers: aiui-slides
(key layer, hints, resolver), the aiui-audio hub (engine + claims), demos/audio (engine +
`LiveDiffText`), demos/walkthrough (key layer). The advanced users were extracted to another repo;
slides carries the remaining complexity. Fixes follow the report, after it is read.

### C — internal packages — `in progress`

`packages/internal/` holds aiui-dock (with the key widget), aiui-oracle, aiui-live: `private: true`,
a workspace glob, `repository.directory`, versioning lockstep, `pnpm skills:check` links, and the
catalog's §5 sister table all follow. READMEs say "internal scaffolding for labs and demos, a
replacement is planned". Nothing leaves the repo. Already-published npm versions are left alone.

### D — skills point at the catalog — `planned`

`skills/aiui-architecture` names CATALOG.md as the reference for what exists, with the caveat that
newer pieces may exist that nothing uses yet, and carries the stance above (build in the main
package; improve, reuse, don't copy). Runs after C so the moved paths are final.

Ordering: A and B run alongside C and D; C lands before D.

## Deferred — noted, not scheduled

- **TextView** is replaced by a richer Markdown view. Open: extract the prompt inspector's renderer
  as the default, or treat it as too niche. Unknown; later.
- **ToolLog** stays (it is the dock's tools pane, the same component) and grows to cover more call
  cases.
- **JsonView**: copy, expand-all, navigation; its `value` is read once (non-reactive).
- **Page and card** against the concepts the owner is about to introduce; many consumers, so
  parallel objects or a careful refactor.
- **SVG and WebRTC** pieces: proposals exist (`semantic-svg.md`, `webrtc-and-companion-pages.md`);
  catalog rows only until they are built.
- **The dock replacement**, and what goes with it (tool inspector, key entry, both voice engines).
- **Remaining ResizeObservers** migrate onto the H2 seam.
- **morphogen's structure-analysis histogram**: now that `PlotFigure` fills its host (H2), it renders at
  182px in the overview panel and its band-axis labels collide (before: a 640px figure scrolling inside
  the panel). Morphogen-side fix: fewer ticks or a minimum width.
- **PromptRecordView** is exactly deferred loading of the prompts inspector; keep as is.

## Dropped

- Deprecating the already-published npm versions of dock, oracle and live.
