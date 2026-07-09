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
local release script and **no** tag trigger — CI is the only publish path. It authenticates via npm
**trusted publishing (OIDC)** — no `NPM_TOKEN` secret. Never run `pnpm publish` / `npm publish` to
cut a release, never push a `vX.Y.Z` tag, and do not suggest a release unless the user explicitly
asks about the process.

**One-time provisioning is not releasing.** `pnpm npm:reserve <slug>` (placeholder-publish a name so
a trusted publisher can be attached) and `pnpm npm:trust <slug>` (attach it) are deliberate local
setup steps run with the human's npm login — see CLAUDE.md → *Trusted publishing*. Do not run them on
your own initiative; only when the user explicitly asks to provision a package for publishing.

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
pnpm npm:reserve # reserve npm name(s) — placeholder publish (local auth); prereq for trust
pnpm npm:trust   # attach the OIDC trusted publisher to npm name(s) (npm >= 11.15.0)
```

`new-package` requires a publication level — see [CLAUDE.md](./CLAUDE.md) for the
`--public` / `--private` / `--no-publish` convention and the trusted-publishing setup. A publishable
`new-package` auto-reserves its npm name (opt out with `--no-reserve`).

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
