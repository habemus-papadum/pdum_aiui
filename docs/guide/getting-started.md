# Getting Started

## Requirements

- Node 24+
- pnpm 11+

```sh
pnpm install
```

## Working in the repo

```sh
pnpm build       # build every package (Vite library mode + tsc .d.ts)
pnpm test        # run all tests (Vitest)
pnpm typecheck   # tsc --noEmit across packages
pnpm lint        # Biome (lint + format check)
```

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
