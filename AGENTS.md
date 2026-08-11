# Agent guardrails for pdum_aiui

## Version management — do NOT touch versions

The `version` field in every `package.json` (the root and every workspace member — `packages/*` and
`demos/*` alike) is managed **exclusively** by the CI release pipeline. Do not edit it, and do not run
`node scripts/versioning.mjs set`. Between releases the tree carries an `X.Y.Z+dev` marker; the
pipeline writes the clean `X.Y.Z` at release time. If you think a version change is needed, tell the
user — do not make it.

## Releasing — do NOT publish

Releasing is a single GitHub Actions workflow: `.github/workflows/release.yml`, a `workflow_dispatch`
a human runs from the Actions UI (or `gh workflow run release.yml -f bump=minor`). There is **no**
local release script and **no** tag trigger — CI is the only publish path.

It has **two modes**, and both live in that one file so there is exactly one workflow that can
publish — one gate, one version computation, one secret surface:

- **release** (default) — stamp `X.Y.Z` across every manifest, commit, tag, publish to `latest`,
  cut a GitHub Release, deploy the gallery.
- **canary** — `gh workflow run release.yml -f canary=true` publishes
  `X.Y.Z-canary.<sha>` under the **`canary`** dist-tag and stops. No commit, no tag, no GitHub
  Release, no site deploy. It exists so a small upstream fix can reach a consumer (see the
  evicted `cc-miner` repo) in a couple of minutes rather than a full release, which is what
  otherwise discourages making the fix upstream at all. `latest` is never touched.

The workflow authenticates with the **`NPM_TOKEN` repo secret** (an npm token from the owner's
account — see CLAUDE.md → *Publication convention*). Never run `pnpm publish` / `npm publish` to
cut a release, never push a `vX.Y.Z` tag, and do not suggest a release unless the user explicitly
asks about the process.

**Name reservation is not releasing.** `pnpm npm:reserve <slug>` (placeholder-publish a name to
claim it ahead of its first real release — optional; nothing requires it) is a deliberate local
step run with the human's npm login. Do not run it on your own initiative; only when the user
explicitly asks. (`pnpm npm:trust` is retired — it belonged to the OIDC trusted-publishing era;
never suggest it as a setup step.)

**The one exception: `bootstrap/` packages.** `bootstrap/aiui-registry` (and any future
`bootstrap/*`) sits OUTSIDE the workspace, carries its own semver, and is published **manually** via
its own `scripts/publish.mjs` — run locally by the human (npm login + 2FA), never from CI and never
via bare `npm publish` (a `prepublishOnly` guard blocks that; the script stages
`optionalDependencies` the source manifest deliberately omits). Everything else in this section —
CI-only releasing, versioning.mjs lockstep — simply does not apply to `bootstrap/`, and conversely:
never fold a bootstrap package into `release.yml` or the lockstep. See CLAUDE.md → *The `bootstrap/`
directory* and the aiui-registry proposal §10 (git history). Do not run its publish script unasked.

## Development

```sh
pnpm install
pnpm build       # Vite library build + tsc .d.ts, per package
pnpm test        # Vitest
pnpm typecheck   # tsc --noEmit
pnpm lint        # Biome (also enforced in CI)
./aiui <cmd>     # run the aiui CLI from source via tsx (e.g. `./aiui claude`)
pnpm new-package <name> (--public | --private | --no-publish) [--no-reserve]
pnpm new-demo <name>    # scaffold demos/<name> — an in-repo demo app on workspace:^ deps
pnpm npm:list    # the packages release.yml would publish
pnpm npm:reserve # optionally claim npm name(s) early — placeholder publish (local auth)
```

`new-package` requires a publication level — see [CLAUDE.md](./CLAUDE.md) for the
`--public` / `--private` / `--no-publish` convention. A publishable `new-package` auto-reserves
its npm name (opt out with `--no-reserve`); no other provisioning exists — the next release
publishes it.

`new-demo` takes no level: demos are never published, but they *are* full workspace members, so they
join version lockstep like everything else — see [CLAUDE.md](./CLAUDE.md) → *In-repo demo apps*.

## Architecture

- pnpm workspace; every `packages/*` is an independent npm package under `@habemus-papadum`.
  `demos/*` are workspace members too, but never published (`pnpm new-demo`).
- **Lockstep versioning**: all workspace members share one version, enforced by
  `node scripts/versioning.mjs current` (checked in CI) — demos included.
- Internal dependencies use `workspace:^` (never hand-pinned).
- **Editable (source-first) deps**: dev manifests point `exports`/`main`/`types` at
  `src/index.ts`; the `dist/` mapping lives in `publishConfig` and is swapped in by pnpm at
  pack/publish time. In-workspace consumers always run live source — no rebuild loop. `bin`
  stays on `dist/` (dev CLI spawning goes through tsx). See CLAUDE.md → *Workspace dependencies
  are editable* for the rules.
- Build: Vite library mode (ESM) + `tsc --emitDeclarationOnly` for `.d.ts` — the *published*
  artifact; the workspace dev loop doesn't consume it.
