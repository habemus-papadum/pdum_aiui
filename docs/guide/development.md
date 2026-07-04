# Developing pdum_aiui

Setting up to work **on this repo**. (To *use* the tools, start at
[Getting Started](./getting-started) instead.)

## Requirements

- Node 24+
- pnpm 11+

```sh
pnpm install
```

## Working in the repo

```sh
pnpm build           # build every package (Vite library mode + tsc .d.ts)
pnpm test            # run all tests (Vitest)
pnpm typecheck       # tsc --noEmit across packages
pnpm lint            # Biome (lint + format check)
pnpm test:packaging  # pack every publishable package, install into a scratch npm project, smoke the CLIs
pnpm test:e2e        # live Claude Code session e2e (spends subscription usage)
```

### Editable workspace dependencies (source-first)

Cross-package dependencies in this monorepo behave like Python *editable installs*: edit a
package, and everything that consumes it — the demo's dev server, a sibling package's tests, the
tsx-run CLI — picks the change up immediately, **no build step**. This works because every
package's dev manifest points at source, while the published `dist/` mapping lives in
`publishConfig`, which pnpm swaps in at `pack`/`publish` time:

```json
"exports": { ".": "./src/index.ts" },
"publishConfig": {
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } }
}
```

Everything in the dev loop (Vite, Vitest, tsx) transpiles TypeScript from linked packages, so
resolving to `.ts` is free; npm consumers see only the `publishConfig` (dist) form. Three things
keep the scheme honest:

- **`bin` entries still point at `dist/`** — bins run under plain `node` from installed
  tarballs. In-workspace, CLIs are spawned from source via tsx (`./aiui`, and
  `resolvePackageCli` for package-to-package spawning), so this costs nothing.
- **The [packaging test](#the-packaging-test) is the guard for the published form.** Source-first
  dev means the workspace *never* exercises `dist/` — and some bugs only exist there. The classic:
  `import.meta.env.*` is substituted when a package is *built*, so prebuilt code can never read
  its consumer's env (the reason the intent tool integrates via a Vite plugin — see the
  [Web Intent Tool internals](./web-intent-tool#how-the-plugin-gets-the-tool-into-the-page-subtle)).
  Run `pnpm test:packaging` whenever packaging fields or build config change.
- **Never `optimizeDeps.include` a workspace package** in a Vite config — the dep-optimizer
  cache is keyed by the lockfile, not file contents, so the linked package would be served stale
  after every edit.

New packages inherit all of this from the `pnpm new-package` skeleton. When adding a subpath
export (like the overlay's `./vite`), add it to **both** the dev `exports` and the
`publishConfig.exports`.

### The packaging test

This repo's tools assume they can be **consumed** — added as a dependency of your own project —
but the unit suite only ever exercises the workspace layout, where `src/` exists, workspace links
resolve, and gitignored build output may or may not be present. `pnpm test:packaging`
(`scripts/packaging-test.mjs`, also a CI job) closes that gap: it builds, `pnpm pack`s every
publishable package, installs the tarballs into a scratch npm project (tarballs satisfy each
other's `@habemus-papadum/*` ranges; the registry only serves third-party deps), and drives the
installed bins the way a consumer would — `aiui --help`, `aiui chrome extension`/`status`,
`aiui mcp --help`, and `aiui claude` failing politely without `claude` on the PATH. It's the test
that catches a missing `files` entry (like the devtools extension shipping without its built
`js/`), a bin that only resolves in the workspace, or a dependency that should have been a
devDependency. It doesn't launch Claude Code or a browser.

## Working on the docs

The documentation site is powered by [VitePress](https://vitepress.dev) with an
[TypeDoc](https://typedoc.org) API-reference step. Four scripts drive it:

```sh
pnpm docs:gen      # regenerate the package pages + API reference + sidebar
pnpm docs:dev      # generate, then serve with hot reload at http://localhost:5173
pnpm docs:build    # generate, then build the static site into docs/.vitepress/dist
pnpm docs:preview  # serve the built static site locally
```

`docs:dev` and `docs:build` run `docs:gen` for you first, so the everyday loop is just:

```sh
pnpm docs:dev
```

Then open the printed local URL. Edit any Markdown under `docs/` or any package `README.md`
and the site hot-reloads. (Changes to a package's **API** — its TypeScript source — need a
`pnpm docs:gen` re-run to re-extract.)

## Adding a new package

Nothing special is required for docs. Create the package as usual:

```sh
pnpm new-package my-lib --public
```

The scaffold ships a `README.md` and a `docs/` folder with a starter page. The next
`pnpm docs:gen` (or `docs:dev`) automatically picks the package up: its README becomes the
overview, its `docs/*.md` become guides, and its exports become an API reference — no doc
config to touch. See [The Documentation System](./documentation) for the full picture.
