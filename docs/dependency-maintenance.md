# Weekly dependency maintenance

The `weekly-dependencies` workflow runs each Tuesday at 09:15 UTC and can
be dispatched manually with `gh workflow run deps-refresh.yml`. It uses the
repository's locked Ship 0.12.0 or newer and the shared refresh action. First-party
packages are selected by `[tool.ship] ours`; normal maintenance retains manifest
floors and third-party compatibility constraints.

## Verification scope

`[tool.ship] refresh-test` owns the maintenance checks independently of release tests:

    pnpm run build
    pnpm run typecheck
    pnpm run test

The entire current workspace unit/type/build suite runs. Browser end-to-end tests, packaging/template integration and multiple-OS lifecycle checks remain in ordinary CI, which is explicitly dispatched after a successful lockfile commit.

## Outcomes and recovery

The shared action verifies the baseline before refreshing. A passing candidate
commits only intended lock/Ship-skill updates, provided main has not advanced,
and dispatches ordinary CI for that new commit. No change means no commit.
A failed valid candidate retains the exact proposed changes and diagnostics for
a draft PR; a baseline, resolution or authentication failure remains a failed
run with its report. Existing human/agent PR work is preserved. This workflow
never publishes a package or deploys a service.

The same steps can be inspected locally from an isolated clean checkout:

```sh
uv run --locked ship deps check
uv run --locked ship deps verify
uv run --locked ship deps refresh --report-dir .ship-refresh
```

Use the Node/pnpm and software prerequisites from the workflow where applicable.
Local refresh restores failed changes by default; the report retains the candidate.
Do not mistake a successful maintenance suite for checks outside the scope above.

## Rollout evidence

Prepared November 10, 2026. Manual workflow verification and any follow-ups are
recorded after the shared action release and pilot have passed.

The original frozen-lock baseline passed 1,927 JavaScript tests with five existing skips, plus the complete workspace build and typecheck. These checks used the existing lock before the shared Ship tooling upgrade; final workflow evidence follows below.

Ship 0.12.0 was installed from PyPI and its synced skills/policy checks passed.
The final configured verification also passed: 1,927 JavaScript tests (five
existing skips), workspace build and typecheck. Existing locked JavaScript
versions were retained; the tooling upgrade added only Ship and packaging.
