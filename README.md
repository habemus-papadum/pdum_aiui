# pdum_aiui

Tooling and knowledge for building **scientific/technical visualization UIs with AI agents in a
tight iteration loop** — keeping an interactive Claude Code CLI session at the center while raising
the level of abstraction you prompt it at. Three layers:

1. **Prompt lowering (intent compilation)** — high-level multimodal prompts (voice, screenshots,
   DOM context, pronouns like "make *this* wider") are *lowered*, compiler-style, into agent-ready
   prompts — **interleaved text and images**, the format current agents execute best — and injected
   into the running session via a custom Claude Code channel. The lowering pipeline is meant to be
   inspectable — an open research area, not just a feature.
2. **Intent tools** — frontends for that pipeline, starting with a browser overlay for the page
   under development (speak a change, capture screenshots/DOM state, send it down the pipeline).
3. **Frontend for agents** — principles, utilities, and Claude skills for the code agents write in
   this loop: SolidJS 2.0 (beta), Observable-style async dataflow, debuggable by the agent's
   future self.

**Full story in the [docs](https://habemus-papadum.github.io/pdum_aiui/):**
[motivation](https://habemus-papadum.github.io/pdum_aiui/guide/motivation) ·
[prompt lowering](https://habemus-papadum.github.io/pdum_aiui/guide/prompt-lowering) ·
[frontend for agents](https://habemus-papadum.github.io/pdum_aiui/guide/frontend-for-agents)

> [!CAUTION]
> **This codebase is dangerous to run.** It injects externally-supplied prompts into your live
> Claude Code session through a custom channel — and can launch that session with
> `--dangerously-skip-permissions` (opt-in via `aiui config set-dsp`, off by default) — which
> means trusting this code completely. It is **safer to read than to run**: treat it as reference
> and parts for building your own system. Details:
> [Read before running](https://habemus-papadum.github.io/pdum_aiui/guide/warning).

A pnpm + TypeScript monorepo. Packages live under `packages/*` in the `@habemus-papadum` scope,
versioned in **lockstep** (one shared version across the whole repo). Each package declares a
publication level — public, private, or never-published — when it's created (see
[CLAUDE.md](./CLAUDE.md)).

## Requirements

- Node 24+
- pnpm 11+ — install it however you like (`brew install pnpm`, the
  [standalone script](https://pnpm.io/installation#using-a-standalone-script), or
  `npm i -g pnpm`). You do **not** need corepack: this repo pins an exact pnpm in
  `package.json` → `packageManager`, and pnpm 10+ automatically downloads and runs that
  exact version for every command in this repo. Every machine (and CI) gets the identical
  pnpm. To change it, run `pnpm pkg set packageManager=pnpm@<version>` and commit.

## Getting started

```sh
pnpm install
pnpm build       # build every package (Vite library mode + tsc .d.ts)
pnpm test        # run all tests (Vitest)
pnpm typecheck   # tsc --noEmit across packages
pnpm lint        # Biome (lint + format check)
pnpm format      # Biome autofix
```

## Add a package

Every package picks a publication level at creation time — pass exactly one of `--public`,
`--private`, or `--no-publish` (see [CLAUDE.md](./CLAUDE.md) for the full convention):

```sh
pnpm new-package my-lib --public       # published publicly as @habemus-papadum/my-lib
pnpm new-package my-lib --private       # published to npm, private (needs a paid npm org)
pnpm new-package demo --no-publish      # internal-only, never published
```

New packages join version lockstep automatically. Internal dependencies use `workspace:^`; pnpm
rewrites them to a concrete version at publish time.

## Documentation

Docs are a monorepo-aware static site — [VitePress](https://vitepress.dev) (Markdown, like MkDocs)
plus a [TypeDoc](https://typedoc.org) API-reference step. It documents the repo at two altitudes:
top-level conceptual docs live under [`docs/`](./docs), and each package contributes its own section
(README → overview, `packages/<slug>/docs/*.md` → guides, `src/index.ts` → an API reference).

```sh
pnpm docs:dev       # generate + serve locally with hot reload (http://localhost:5173)
pnpm docs:build     # generate + build the static site into docs/.vitepress/dist
pnpm docs:preview   # serve the built static site
pnpm docs:gen       # regenerate package pages + API + sidebar only
```

The site is generated from the same `packages/*` glob everything else uses, so **adding a package
needs no doc-config changes** — its pages and API reference appear automatically on the next
`docs:gen`. `scripts/docs-gen.mjs` is the generator; `docs/guide/documentation.md` explains the
system in full. The generated tree (`docs/packages/**`, the sidebar, VitePress `cache/`/`dist/`) is
gitignored.

## Releasing

Releases run **entirely in CI** — there is no local release script and no tag trigger. From the
GitHub Actions UI run the **release** workflow (or `gh workflow run release.yml -f bump=minor`),
choosing `patch`, `minor`, or `major`. The pipeline:

1. **gate** — require this commit's CI to be green (skippable with `skip_ci_check`).
2. **prepare** — compute the next version from the highest `vX.Y.Z` tag, write it across every
   `package.json`, commit, tag `vX.Y.Z`, push.
3. **npm-publish** — `pnpm -r publish --provenance` (private packages are skipped).
4. **github-release** — a GitHub Release with generated notes.
5. **finalize** — return `main` to a `X.Y.Z+dev` marker.

Use `dry_run: true` to compute the version and preview the diff without committing or publishing.

Between releases the tree carries an `X.Y.Z+dev` version — npm rejects it, so a stray publish can't
overwrite a released version.

### One-time setup

Add an npm automation token as the `NPM_TOKEN` Actions secret (Settings → Secrets and variables →
Actions). Provenance additionally requires the repo to be public (or npm Pro/Teams).

## Layout

```
packages/*               published libraries (shared lockstep version)
docs/                    documentation site (VitePress) — top-level guides + generated package docs
scripts/versioning.mjs   the lockstep version engine (CI-managed — do not run `set` by hand)
scripts/new-package.mjs  scaffolder for new packages
scripts/docs-gen.mjs     docs generator — package pages + TypeDoc API + sidebar
.github/workflows/       ci.yml (gate) + release.yml (publish)
```
