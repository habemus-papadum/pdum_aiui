# Agent guardrails for pdum_aiui

## Versions and releases

`ship` (habemus-papadum-ship) releases this repository's packages. Each publishable package under
`packages/*` has its own version and its own tag series, `<package>-v<version>` (the npm name
without the scope: `aiui-viz-v0.24.0`). Between releases a manifest says `<last release>+dev`.
Never edit a `version` field by hand; `ship deps check` reports anything other than the marker.
Private workspace members (`packages/internal/*`, the spikes, every demo, `aiui-build-config`)
carry `0.0.0` and are never released; the root `package.json` and the plugin manifest
`.claude-plugin/plugin.json` are not packages (the plugin's version is bumped by hand, see
CLAUDE.md).

To release, ask the operator; when they agree, run the release workflow for one package:

```sh
gh workflow run release.yml -f package=@habemus-papadum/aiui-viz -f bump=minor -f dry_run=true   # see the plan
gh workflow run release.yml -f package=@habemus-papadum/aiui-viz -f bump=minor -f dry_run=false  # release
```

The workflow waits for this commit's CI, builds the package and its workspace dependencies, runs
the workspace's tests, publishes to npm, tags, pushes, creates the GitHub release and restores the
`+dev` marker. Do not publish from this machine; never run `pnpm publish` or push a tag by hand.
There is no canary mode: a consumer that needs a fix gets a patch release of the one package.

Do not update repositories that consume a package you changed; their scheduled refresh does that.
The one exception: if your change needs a newer release of another `@habemus-papadum/*` package,
raise that package's floor here. Do not pin one of our packages to an exact version without a
reason on the same line or in `[tool.ship.pins]` (`pyproject.toml`). Never commit a `link:` or
`file:` dependency, or a `path`/`editable` entry in `[tool.uv.sources]` (`pnpm link` writes one).

Run `uv run ship deps check` before you finish. The `ship-release` and `ship-adopt` skills under
`.agents/skills/` (mirrored at `.claude/skills/`) are written by `uv run ship skills sync`; do not
edit them.

**The npm token.** The workflow authenticates with the `NPM_TOKEN` repository secret, an npm
*granular access token* with an expiry chosen at creation (the one set 2026-10-08 expires
**2027-01-06**; `gh secret list` shows the date it was set). An expired token fails the publish
with `404 Not Found - PUT …` (npm answers an unauthorized PUT with 404). ship publishes before it
commits or tags, so a failed publish leaves nothing behind: replace the secret
(`gh secret set NPM_TOKEN --repo habemus-papadum/pdum_aiui`) and run the workflow again. Two more
registry facts as of 2026-10: a token's first publish of a NEW package leaves a public
`0.0.0-stage` placeholder version beside the real one (harmless; carets never match it), and npm
removes direct publishing by bypass-2FA tokens in **January 2027** — before then ship's reusable
workflow must move to trusted publishing (OIDC) or to staged publishing with a human 2FA approval.

**Name reservation is not releasing.** `pnpm npm:reserve <slug>` (placeholder-publish a name to
claim it ahead of its first real release — optional; nothing requires it) is a deliberate local
step run with the human's npm login. Do not run it on your own initiative; only when the user
explicitly asks.

## Development

```sh
pnpm install
pnpm build       # Vite library build + tsc .d.ts, per package
pnpm test        # Vitest
pnpm typecheck   # tsc --noEmit
pnpm lint        # Biome (also enforced in CI)
pnpm demo        # the notebook gallery's dev server (every demo, one site)
pnpm -C demos/<slug> dev   # one demo on its own
pnpm new-package <name> (--public | --private | --no-publish) [--no-reserve]
pnpm new-demo <name>    # scaffold demos/<name> — an in-repo demo app on workspace floors
pnpm npm:list    # the packages ship would publish
pnpm npm:reserve # optionally claim npm name(s) early — placeholder publish (local auth)
uv run ship packages   # every package, its manifest version and its last tag
uv run ship changed    # packages with commits since their last release
```

`new-package` requires a publication level — see [CLAUDE.md](./CLAUDE.md) for the
`--public` / `--private` / `--no-publish` convention. A publishable package starts at `0.0.0+dev`
with no tag; its first release computes `0.1.0` or `0.0.1`. A publishable `new-package`
auto-reserves its npm name (opt out with `--no-reserve`); no other provisioning exists — the next
release publishes it.

`new-demo` takes no level: demos are never published and carry `0.0.0`, but they *are* full
workspace members — see [CLAUDE.md](./CLAUDE.md) → *In-repo demo apps*.

## Architecture

- pnpm workspace; every `packages/*` is an independent npm package under `@habemus-papadum`,
  released on its own. `demos/*` are workspace members too, but never published (`pnpm new-demo`).
- Dependencies between packages are floors: `workspace:>=X.Y.Z` on the sibling's last release
  (published as `>=X.Y.Z`), `workspace:>=0.0.0` on a private sibling, `workspace:*` in
  `devDependencies`. Never `workspace:^` (it publishes as one minor of a 0.x package) and never a
  hand-written exact version.
- In a library, a sibling or framework whose objects cross the public API or that holds
  process-wide state is a **peer dependency** with a floor, plus a `workspace:*` (or catalog)
  devDependency so the package builds and tests alone: `aiui-viz` (its scopes, registries, mode
  engine and key layer are one per document) for audio, screen-capture, slides and cf-creds;
  `aiui-prompts` (its records and `PromptError` cross the inspector's, the Vite plugin's and
  aiui-viz's APIs); `aiui-audio` (its `AudioSource` crosses aiui-stt's); `solid-js` and
  `@solidjs/web` everywhere they are used. A sibling used only internally is a regular dependency
  with the same floor form.
- **Editable (source-first) deps**: dev manifests point `exports`/`main`/`types` at
  `src/index.ts`; the `dist/` mapping lives in `publishConfig` and is swapped in by pnpm at
  pack/publish time. In-workspace consumers always run live source — no rebuild loop. `bin`
  stays on `dist/` (create-aiui's bin is run by plain node from the installed tarball). See
  CLAUDE.md → *Workspace dependencies are editable* for the rules.
- Build: Vite library mode (ESM) + `tsc --emitDeclarationOnly` for `.d.ts` — the *published*
  artifact; the workspace dev loop doesn't consume it.
- The repo root is a Claude Code plugin (`.claude-plugin/`, reusable skills in `skills/`); its
  manifest `version` is the plugin's own, bumped by hand (CLAUDE.md).
