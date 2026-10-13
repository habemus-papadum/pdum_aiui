# Source-first TypeScript workspaces

An application can consume a workspace library's TypeScript source directly. Editing that
library then follows the application's normal Vite update path, without building the library
first. Published consumers can still receive compiled JavaScript and declarations.

This uses ordinary package-manager links, package exports, and Vite's linked-dependency
support. No AIUI runtime or special monorepo plugin is required. Turborepo calls the source
consumption pattern [Just-in-Time packages](https://turborepo.dev/docs/core-concepts/internal-packages).

## Choose the scope

Inspect the target's workspace definition, package manager, exports, build scripts, Vite and
TypeScript configuration, and release workflow. Pick one app and one library it imports to
verify the setup before applying it across the workspace.

Keep existing names, versions, framework plugins, and release conventions. Examples below
are configuration fragments to merge, not complete replacement manifests. Packages used
only inside the workspace can stay private and need no publication build. A plain Node CLI
or another consumer that needs compiled code may retain a build requirement.

This recipe covers packages in one workspace. A directory merely being adjacent to an app
does not make it a dependency. Separate repository checkouts require an explicit linking
policy; this repo's [sibling-link proposal](../../../docs/proposals/sibling-dev-links.md) is
speculative, not an implemented prerequisite.

## Link packages and expose source

For pnpm, include the actual application and library directories in `pnpm-workspace.yaml`:

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

Declare the dependency in the consuming app's `package.json`:

```json
{
  "dependencies": {
    "@example/math": "workspace:^"
  }
}
```

Expose the library's source through its development manifest:

```json
{
  "name": "@example/math",
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "main": "./src/index.ts",
  "module": "./src/index.ts",
  "types": "./src/index.ts"
}
```

`exports` selects the modern package entry; the other fields keep readers of legacy fields
aligned. Add each public subpath explicitly, pointing at its actual source entry. Import
through the package name in application code. Avoid adding parallel TypeScript `paths` or
Vite aliases that bypass the package's public exports.

Run the target's normal install from its workspace root. Confirm the dependency resolves
to the library checkout and its source entry, rather than a registry copy or old `dist`
output. pnpm's [workspace protocol](https://pnpm.io/workspaces#workspace-protocol-workspace)
requires local workspace resolution and converts workspace ranges when packing.

## Let the application compile and watch

Keep the app's normal Vite configuration and framework plugin. Vite follows linked package
paths and [treats linked ESM dependencies as source](https://vite.dev/guide/dep-pre-bundling#monorepos-and-linked-dependencies).
It transforms TypeScript; the framework plugin must also process linked `.tsx`, `.vue`, or
other framework files. Check plugin include/exclude filters if they are restricted to the
app directory. Keep typechecking as a separate command: Vite's transformation is not a typecheck.

Use Vite's default realpath resolution (`resolve.preserveSymlinks: false`). Avoid adding
workspace packages to `optimizeDeps.include`: their source edits are not normal dependency
cache invalidation inputs. Existing prebundled copies may need a one-time server restart
with `--force` after migration. Continuous rebuilds or repeated cache deletion should not
be part of the resulting edit loop.

Vite normally detects the workspace root for filesystem access. If the app already sets
`server.fs.allow`, preserve workspace access and add only the necessary directories; do not
disable filesystem restrictions to solve an import error. See [Vite server options](https://vite.dev/config/server-options#server-fs-allow).

Shared framework runtimes should resolve consistently. Align their versions with the
target's existing dependency policy. If linked packages resolve duplicate runtimes, inspect
their actual paths and consider targeted `resolve.dedupe` entries for those runtimes. Do not
deduplicate every package indiscriminately.

Updates propagate through Vite's module graph. A framework HMR boundary can replace a module;
otherwise the browser may reload. Preserving application state across updates is a separate
framework/application concern. Files that are never imported do not affect the active page.

## Keep published entry points on built files

For a library intended for publication, add a matching built mapping using pnpm's
[`publishConfig` overrides](https://pnpm.io/package_json#publishconfig):

```json
{
  "files": ["dist"],
  "publishConfig": {
    "main": "./dist/index.js",
    "module": "./dist/index.js",
    "types": "./dist/index.d.ts",
    "exports": {
      ".": {
        "types": "./dist/index.d.ts",
        "import": "./dist/index.js",
        "default": "./dist/index.js"
      }
    }
  }
}
```

Merge `files` with any required assets or intentionally shipped sources. Preserve existing
publication access settings. Private internal packages need neither this mapping nor a
change to their publication status.

The existing build must emit the files actually named here. JavaScript bundles and `.d.ts`
files can have different layouts, especially for subpaths. Keep the source and published
export names aligned, and ensure a later build step does not delete declarations emitted
by an earlier step. Externalize runtime/peer dependencies in library bundles where they
must retain shared identity with the consumer.

Put `types` first and the fallback `default` last in these published condition objects.
The fallback supports consumers using `require.resolve()` to locate the entry; it does not
promise that every CommonJS runtime can execute the ESM module. Existing `bin` entries that
run with plain Node should keep pointing at built executables; use a source-capable runner
for a separate local CLI development command if needed.

The export rewrite depends on **pnpm packing the package**. A workflow using `npm pack`
does not provide pnpm's field-override behavior. Verify the actual release path, not just
the package manager used to install dependencies. Packing is local validation and does not
publish a package.

Built libraries also need configuration that survives precompilation: expressions such as
`import.meta.env.*` can be replaced during the library build. Use runtime arguments or
another explicit injection contract for values supplied by the consuming application.

## Alternatives for other toolchains

For internal libraries, source exports also work with other package managers' workspace
links; use that package manager's dependency syntax. For published libraries where pnpm's
packing overrides do not fit, custom export conditions provide another approach:

```json
{
  "exports": {
    ".": {
      "@example/source": "./src/index.ts",
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  }
}
```

Enable the same scoped condition in Vite/Vitest `resolve.conditions` and TypeScript
`compilerOptions.customConditions`, preserving other needed conditions. TypeScript needs
a compatible module-resolution mode such as `bundler`, `node16`, or `nodenext`. Source must
precede `types` so type-aware consumers also select it. Configure other runners consistently;
enabling a condition selects a file but does not supply TS or JSX compilation. Decide
explicitly whether app production builds consume source or built dependencies. Default
published consumers use `dist`; ship source as well if supporting the source condition in
installed packages. [Nx documents this pattern](https://nx.dev/docs/kb/testing-without-building-dependencies).

A library build watcher remains appropriate for consumers that require compiled artifacts.
Use it deliberately rather than promising a build-free loop in that case. Adding Nx,
Turborepo, alias plugins, or a custom watcher is not required for the pnpm/Vite source recipe.

## Verify the two contracts separately

**Live source:** start the chosen app without running the library build. Exercise an import
through the library's public entry. Change a visible value or behavior in that library's
TypeScript while the server remains running, and observe the browser update without manual
refresh. If the library includes framework components, also exercise an edit to one of
those components. Confirm the module comes from source and the dev server did not restart.
Record whether it was an HMR replacement or automatic page reload.

Use a disposable fixture or a temporary edit with exact restoration, preserving any existing
user changes. For CI, prefer a temporary app/library workspace following the real conventions
over mutating a developer's live checkout. A manifest assertion can catch exports reverting
to `dist`, but it cannot prove watcher behavior. Run the target's typecheck too.

**Installed artifacts, when applicable:** build, pack with the release package manager, and
install the tarballs into a temporary consumer outside the workspace. Supply internal
dependency tarballs together so the registry cannot silently provide older sibling code.
Check shipped export targets and declarations, and exercise a representative consumer
import/build or CLI. A successful local source import does not validate a published package.

Upstream validators can share this work: [publint](https://publint.dev/docs/cli) accepts a
tarball and checks packaging rules; [Are the types wrong?](https://github.com/arethetypeswrong/arethetypeswrong.github.io/tree/main/packages/cli)
checks published TypeScript resolution. Match their checks to the package's intended
environments. Keep behavioral smoke tests for app-specific assets and executables.

In this repository, [the package skeleton](../../../scripts/_skeleton/package.json.tmpl)
provides the pnpm manifest shape and [the packaging check](../../../scripts/packaging-test.mjs)
builds, packs, installs, resolves concrete exports, and exercises installed CLIs. It does not
currently test cross-package HMR or validate every declaration. [CLAUDE.md](../../../CLAUDE.md#workspace-dependencies-are-editable-source-first--the-convention)
records this repository's additional conventions. These files are references for adapting
the recipe, not prerequisites to copy into another project.
