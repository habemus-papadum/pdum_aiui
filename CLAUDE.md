# pdum_aiui — publication convention

Guidance for humans and agents working in this repo. See also [AGENTS.md](./AGENTS.md) for
version/release guardrails.

> **Assumption: this project has a paid npm account/org.** Publishing scoped packages
> (`@habemus-papadum/*`) as private (`--private`, `restricted` access) requires it, and the release
> workflow's `NPM_TOKEN` is expected to belong to that org. On the free tier, scoped packages can
> only be published as `--public`.

## Every package declares a publication level at creation time

There is **no default**. `pnpm new-package <name>` requires exactly one of three flags, so the
publish/visibility decision is made deliberately when the package is born:

```sh
pnpm new-package foo --public       # published to npm, publicly visible
pnpm new-package foo --private       # published to npm, private (restricted access)
pnpm new-package foo --no-publish    # never published — internal/experimental only
```

Passing none, or more than one, is an error.

| Flag           | `package.json` result                     | On the npm registry                          |
| -------------- | ----------------------------------------- | -------------------------------------------- |
| `--public`     | `"publishConfig": { "access": "public" }` | Public package, anyone can install.          |
| `--private`    | `"publishConfig": { "access": "restricted" }` | Private package, only your npm org can install. |
| `--no-publish` | `"private": true` (no `publishConfig`)    | Never published — `pnpm -r publish` skips it. |

### `--private` relies on the paid-account assumption

Publishing a **scoped** package as `restricted` needs the paid npm org noted at the top of this
file — the release workflow's `NPM_TOKEN` must belong to an org that allows private packages, or
every `--private` package's publish will error. (Were this project ever on the free tier, the only
non-public option would be `--no-publish`: hold a package back and flip it to `--public` when ready.)

## Changing a package's level later

The level lives in `packages/<slug>/package.json`; edit it and the next release reflects the change.

- **`--no-publish` → publish it:** remove `"private": true`, add
  `"publishConfig": { "access": "public" | "restricted" }` and the `"files": ["dist"]` array
  (copy the shape from another package). The next release publishes it.
- **`--private` → `--public` (open it up):** the registry does **not** flip visibility implicitly.
  Run `npm access set access=public @habemus-papadum/<slug>` (or toggle it on npmjs.com), and set
  `publishConfig.access` to `"public"` so future releases stay public. This direction is free.
- **`--public` → `--private` (lock it down):** requires a paid plan, and npm restricts making a
  public package private once it has dependents. Avoid unless you know the package has no consumers.

Note: `publishConfig.access` only sets the access level on a package's **first** publish. After
that, `npm access` is the source of truth for visibility — changing `publishConfig` alone won't
retroactively change an already-published package.

## Publishing is CI-only

Publishing happens **exclusively** through `.github/workflows/release.yml` (a manual
`workflow_dispatch`). Never run `pnpm publish` / `npm publish` locally. See [AGENTS.md](./AGENTS.md).
