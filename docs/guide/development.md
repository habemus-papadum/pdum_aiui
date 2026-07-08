# Developing pdum_aiui

Setting up to work **on this repo**. (To *use* the tools, start at
[Getting Started](./getting-started) instead.)

## Requirements

- Node 24+
- pnpm 11+

```sh
pnpm install
```

## Activate your shell (optional, venv-style)

```sh
eval "$(./aiui env)"
```

This is the repo's `. .venv/bin/activate`: it prepends `bin/` (the source-run `aiui` shim —
no build needed) and the workspace `node_modules/.bin` (`tsx`, `vite`, `vitest`, `biome`) to
your PATH, and exports the root `.env` / `.env.dev` files (`OPENAI_API_KEY`,
`GEMINI_API_KEY`) into the current shell — so `aiui claude` picks the keys up without a
manual `export`. Undo with `aiui_deactivate`. The script is idempotent and prints what it did
(key *names* only) to stderr.

There's no pnpm-native equivalent (`pnpm exec` scopes one command, `pnpm bin` just prints the
path). For automatic activation on `cd` — the zsh-friendly version — install
[direnv](https://direnv.net), hook it into your shell (`eval "$(direnv hook zsh)"` in
`~/.zshrc`), and run `direnv allow` once: the checked-in `.envrc` does the same PATH + dotenv
setup, and undoes it when you leave the directory.

## Working in the repo

```sh
pnpm build           # build every package (Vite library mode + tsc .d.ts)
pnpm test            # run all tests (Vitest)
pnpm typecheck       # tsc --noEmit across packages
pnpm lint            # Biome (lint + format check)
pnpm test:packaging  # pack every publishable package, install into a scratch npm project, smoke the CLIs
pnpm test:e2e        # live Claude Code session e2e (spends subscription usage)
pnpm workbench       # the intent overlay's offline lab (mock backends, no channel, no key)
```

`pnpm workbench` runs the **intent workbench** — the pipeline mounted on instrumented scenery with
the [mock transcriber/corrector](https://github.com/habemus-papadum/pdum_aiui/tree/main/packages/aiui-dev-overlay/workbench#the-mock-backends)
as its defaults, for latency/accuracy measurement, pipeline-config research, and fixture capture.
It's where the mocking infrastructure lives; the shipping overlay defaults to the real
channel-side backends.

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
resolving to `.ts` is free; npm consumers see only the `publishConfig` (dist) form. This extends
to packages shipping **JSX** (`aiui-viz` exports `.tsx` in dev): vite-plugin-solid compiles any
served `.tsx` and only suppresses solid-refresh for `/node_modules/` ids — workspace links
resolve to real `packages/*` paths, so linked component sources get compilation *and* HMR in
consumers. Three things
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

### Hot-reloading the running channel

Source-first dev picks up edits everywhere the code is *transpiled on demand* — but the
`aiui-claude-channel` MCP server is a long-lived process behind a live Claude Code session, so its
already-loaded lowering code doesn't update on edit like a Vite page does. It can **reload in
place** instead: the `channel_reload` MCP tool (or `POST /debug/api/reload`, or
`AIUI_CHANNEL_WATCH=1` for auto-reload on save) rebuilds the format registry from the code now on
disk without restarting the process. Live websockets drop and reconnect on their own; the session
and the web port stay up. Reload reaches the format entry modules (`processors.ts`, `intent-v1.ts`)
and their edits — deeper changes still want a relaunch. See the channel's
[websocket-protocol doc](https://github.com/habemus-papadum/pdum_aiui/tree/main/packages/aiui-claude-channel/docs/websocket-protocol.md#hot-reload)
for what survives and what drops.

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

## Every string boundary is a compiler you can't see

When program text crosses into another language's string literal — JS inside a TS template
literal, shell emitted by `aiui env`, JSON riding a CLI flag — escape processing happens once
**per layer**, and the inner program sits in the blind spot of every tool: tsc doesn't parse it,
Biome doesn't lint it, your editor doesn't highlight it. This bit for real: the iPad paint
client once lived in a TS template literal, and a `"\n"` typed into its inline JS shipped a raw
*newline* inside a string literal — a SyntaxError that left every viewer stuck on
"Connecting…", with nothing anywhere to say why.

The rules, in order of preference:

1. **Don't embed — load a real file** of the target language. The paint client is now
   `packages/aiui-paint/assets/ipad-client.html`, read at import with a path computed from
   `import.meta.url` and shipped via the package's `files` (an eager, module-level read makes a
   missing asset fail at import, where `pnpm test:packaging` catches it). Note: Vite's
   `?raw` import is not an option for anything that must also run under tsx (`aiui claude`, the
   workbench) — tsx doesn't support it.
2. **If you must emit code as strings** (the generator is the point, e.g. `aiui env`'s shell
   output), keep the generator trivial and **test the emitted artifact by parsing or executing
   it** — `aiui env`'s output round-trips through a real `sh` in its tests; the paint client's
   inline script is parsed with `new Function` in its.
3. **If you must hand-author inside a literal**, state the escaping rules in a comment at the
   top of the literal *and* enforce them with a test. A comment alone already failed once.
