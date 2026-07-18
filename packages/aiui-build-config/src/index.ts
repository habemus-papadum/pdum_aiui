/**
 * Internal build-config helpers — the ONE home of the config blocks every
 * package's vite config used to restate (and drift). Never published: this is
 * a `private` workspace member consumed source-first by vite.config.ts files
 * (Vite's config loader bundles the import). The create-aiui app TEMPLATE
 * cannot use it (scaffolded apps live outside the workspace) and keeps its own
 * inline copy with a pointer here.
 */
import { builtinModules } from "node:module";

/** The dependency fields {@link externalizeDeps} reads off a package.json. */
export interface PackageDeps {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/**
 * The library-build external matcher: Node builtins (bare and `node:`-prefixed)
 * plus everything the package declares as a runtime/peer dependency — so the
 * bundle never inlines a consumer-provided module — plus any `extras` (modules
 * imported LAZILY that must stay out of the bundle even though they are not
 * declared deps, e.g. aiui-util's dev-only `vite` import).
 */
export function externalizeDeps(pkg: PackageDeps, extras: string[] = []): (id: string) => boolean {
  const external = [
    ...builtinModules,
    ...builtinModules.map((name) => `node:${name}`),
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
    ...extras,
  ];
  return (id) => external.some((mod) => id === mod || id.startsWith(`${mod}/`));
}

/**
 * Solid under Vitest: `test.server.deps` that force solid-js INLINE.
 *
 * Node's export conditions hand @solidjs/web a SERVER build of solid-js, so
 * `_$effect` calls a DIFFERENT instance of `createRenderEffect` than a test's
 * `import { getObserver } from "solid-js"` observes. The DOM is still written
 * once (so most tests pass), but there is no observer during the compute and
 * no reactivity on update. Probe: inside `effect()` from @solidjs/web,
 * `getObserver()` is null, while inside `createRenderEffect` from solid-js it
 * is the effect node.
 *
 * vite-plugin-solid force-externalizes /solid-js/ unless the user config
 * already lists a matching external — the never-matching regex (its SOURCE
 * matches the plugin's /solid-js/ gate) exists purely to defeat that, so
 * `inline` wins and {@link SOLID_TEST_CONDITIONS} resolves one shared dev
 * build.
 */
export const solidTestDeps = {
  external: [/^never-external-solid-js$/],
  inline: [/solid-js/, /@solidjs\//],
};

/**
 * The resolve conditions that pair with {@link solidTestDeps}: browser +
 * development, so the inlined solid is the one shared dev build. Only
 * meaningful under Vitest — a lib build's externals never resolve, and app
 * consumers bring their own config. (Packages mixing node `ws` tests with
 * jsdom Solid tests must also pin `ws` to its node entry — see
 * aiui-remote-bar/aiui-intent-client's configs.)
 */
export const SOLID_TEST_CONDITIONS = ["browser", "development", "import", "module", "default"];
