# The Documentation System

This site is a small "MkDocs for a pnpm monorepo": Markdown-first, monorepo-aware, and
generated from the same `packages/*` glob the rest of the repo uses. It is built from three
pieces:

| Piece | Role |
| ----- | ---- |
| [VitePress](https://vitepress.dev) | The static-site generator — renders Markdown, serves locally, builds the static site. |
| [TypeDoc](https://typedoc.org) + [`typedoc-plugin-markdown`](https://typedoc-plugin-markdown.org) | Extracts a Markdown API reference from each package's TypeScript source. |
| [`scripts/docs-gen.mjs`](https://github.com/habemus-papadum/pdum_aiui/blob/main/scripts/docs-gen.mjs) | The glue: discovers packages, assembles their pages, runs TypeDoc, and writes the sidebar. |

## The two altitudes

The monorepo documents itself at two levels, and the layout mirrors that:

```
docs/                       ← VitePress content root (srcDir)
  index.md                  home page                         (tracked)
  guide/                    top-level conceptual docs          (tracked)
  <other notes>.md          auto-listed under "Notes"          (tracked)
  packages/                 GENERATED — do not edit by hand    (gitignored)
    index.md                package overview grid
    <slug>/index.md         ← packages/<slug>/README.md
    <slug>/<guide>.md       ← packages/<slug>/docs/*.md
    <slug>/api/**           ← TypeDoc Markdown for the package
  .vitepress/
    config.ts               VitePress config                   (tracked)
    sidebar.generated.json  GENERATED sidebar                  (gitignored)
```

- **Top-level, conceptual docs** are hand-written Markdown living directly under `docs/`. The
  curated ones are in `guide/`; any other `*.md` you drop under `docs/` is auto-listed in the
  **Notes** section of the sidebar.
- **Per-package docs** are assembled per package from three sources: the package `README.md`
  (becomes the overview), any `packages/<slug>/docs/*.md` (become guides), and the package's
  exported API (becomes the **API Reference**).

## How generation works

`pnpm docs:gen` runs [`scripts/docs-gen.mjs`](https://github.com/habemus-papadum/pdum_aiui/blob/main/scripts/docs-gen.mjs), which:

1. **Discovers packages** with `globSync("*/package.json")` under `packages/` — the same
   convention `new-package` and versioning use.
2. For each package, **copies the README** to `docs/packages/<slug>/index.md` and any
   `packages/<slug>/docs/*.md` guides alongside it.
3. **Runs TypeDoc** against `packages/<slug>/src/index.ts` (using that package's `tsconfig.json`),
   emitting Markdown into `docs/packages/<slug>/api/` plus a ready-made sidebar fragment.
4. **Writes the combined sidebar** to `docs/.vitepress/sidebar.generated.json`, which
   `config.ts` imports.

Because everything is keyed off the glob, **a new package needs zero doc-config edits**. The
generated tree is rebuilt from scratch each run, so deleting a package or a page cleans up after
itself.

## Extending it

- **Add a conceptual doc:** drop a `*.md` file anywhere under `docs/` (outside `packages/`).
  It appears under **Notes**; move it into `guide/` and add it to the curated Guide list in
  `docs-gen.mjs` if it's foundational.
- **Add per-package prose:** create `packages/<slug>/docs/whatever.md`. It becomes a guide page
  under that package on the next `docs:gen`.
- **Improve the API reference:** write [TSDoc](https://tsdoc.org) comments in the package's
  source. Anything exported from `src/index.ts` is documented; `@internal` members are excluded.

## What's tracked vs. generated

Only hand-written content is committed. The generated tree — `docs/packages/**` and
`docs/.vitepress/sidebar.generated.json`, plus VitePress's `cache/` and `dist/` — is gitignored
and rebuilt by `docs:gen`. Never edit those by hand.
