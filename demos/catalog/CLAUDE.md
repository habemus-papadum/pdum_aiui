# demos/catalog — the aiui-viz catalog, as a page

This demo renders `packages/aiui-viz/CATALOG.md` — the reference inventory of what the package
provides — with the pieces themselves shown live under the entries that can be shown. Like the
styleguide it has no subject of its own: its "model" is one damped wave (frequency, damping,
shape) declared so the real components can be exhibited over real controls, and every live
specimen on the page moves that one wave.

How it is built:

- **The text is the file.** `src/model/catalog-source.ts` imports the catalog with Vite's `?raw`,
  `src/model/catalog.ts` parses the Markdown subset it uses (headings, paragraphs, tables, lists,
  fences) and classifies piece tables, and `src/ui/Catalog.tsx` renders the result. Edit the
  catalog, not this demo, to change what the page says; links are rewritten against the file's
  GitHub URL.
- **Specimens hang on catalog keys.** `src/model/specimen-keys.ts` lists the entries that carry a
  live specimen, by the key `pieceKey` derives from the entry's name (its first code span, else a
  slug). `src/ui/specimens/index.ts` is typed against that list, and `catalog.test.ts` checks every
  key against the real file — a renamed or retired row fails the tests here. Add a specimen by
  adding its key and its component; nothing else to register.
- **A specimen is the real component.** Real class names, real stamps, the page's own controls;
  a styling or behavior change to a piece breaks it here first. The stamp inspector
  (`src/ui/StampInspector.tsx`) shows the `data-*` stamps under the pointer inside any specimen.
- **The look is the design system's.** `src/styles.css` holds only this page's own chrome (the
  entry list, the badges, the specimen frames, the stamp bar) plus a skin for the two spike
  components — RichTeX and Mermaid — that `aiui-design` does not dress yet; it is a copy of the
  aiui-viz lab's, scoped under `.catalog`. When the design package gains those rules, delete the
  copy here. Likewise `src/ui/mermaid-theme.ts` duplicates the lab's Mermaid theme.

This page is a sheet, not evidence: an entry's state (shipped · spike · proposed) is the
catalog's judgement from notebooks and labs, and a specimen here does not promote a row.

Run it standalone with `pnpm dev` here, or in the gallery via `pnpm demo` → `/catalog`.
