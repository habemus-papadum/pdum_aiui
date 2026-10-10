# Agent guardrails for pdum_aiui

## Version management — do NOT touch versions

The `version` field in every `package.json` (the root and every workspace member — `packages/*` and
`demos/*` alike) **and in the repo-root Claude-plugin manifest `.claude-plugin/plugin.json`** is
managed **exclusively** by the CI release pipeline. Do not edit it, and do not run
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
  cut a GitHub Release, deploy the gallery (the demo notebooks' static site).
- **canary** — `gh workflow run release.yml -f canary=true` publishes
  `X.Y.Z-canary.<sha>` under the **`canary`** dist-tag and stops. No commit, no tag, no GitHub
  Release, no site deploy. It exists so a small upstream fix can reach a consumer in a couple of
  minutes rather than a full release, which is what otherwise discourages making the fix
  upstream at all. `latest` is never touched.

The workflow authenticates with the **`NPM_TOKEN` repo secret** (an npm token from the owner's
account — see CLAUDE.md → *Publication convention*). Never run `pnpm publish` / `npm publish` to
cut a release, never push a `vX.Y.Z` tag, and do not suggest a release unless the user explicitly
asks about the process.

**The token expires.** `NPM_TOKEN` is an npm *granular access token* with an expiry chosen at
creation (the one set 2026-10-08 expires **2027-01-06**; `gh secret list` shows the date it was
set). An expired token fails the publish with `404 Not Found - PUT …` on the first package —
npm answers an unauthorized PUT with 404, which reads like "package not found" — AFTER
`prepare` has already committed and pushed the stamped version and the `vX.Y.Z` tag. Recover by
replacing the secret (`gh secret set NPM_TOKEN --repo habemus-papadum/pdum_aiui`) and re-running
the failed job in place: `gh run rerun <run-id> --failed`. Never re-dispatch the workflow for
that release — it would compute the NEXT version from the tag that already exists. Two more
registry facts as of 2026-10: a token's first publish of a NEW package leaves a public
`0.0.0-stage` placeholder version beside the real one (harmless; carets never match it), and
npm removes direct publishing by bypass-2FA tokens in **January 2027** — before then this
workflow must move to trusted publishing (OIDC; pnpm already attempts the exchange) or to
staged publishing with a human 2FA approval.

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
  stays on `dist/` (create-aiui's bin is run by plain node from the installed tarball). See
  CLAUDE.md → *Workspace dependencies are editable* for the rules.
- Build: Vite library mode (ESM) + `tsc --emitDeclarationOnly` for `.d.ts` — the *published*
  artifact; the workspace dev loop doesn't consume it.
- The repo root is a Claude Code plugin (`.claude-plugin/`, one skill in `skills/`); its
  manifest version is part of the lockstep above.
