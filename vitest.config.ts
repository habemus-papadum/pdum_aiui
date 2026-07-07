import { defineConfig } from "vitest/config";

// Aggregate every workspace package as a Vitest project; each package supplies its
// own vite.config.ts. `vitest run` at the root runs the whole monorepo at once.
//
// `!packages/aiui-code` is excluded deliberately: the reader FRONTEND has no unit
// tests (its logic tests live in aiui-code-server), and its harness vite.config's
// `configureServer` mounts the reader backend + would spin up LSP servers if
// Vitest initialized it as a project. Nothing to run there, so skip it.
export default defineConfig({
  test: {
    projects: ["packages/*", "!packages/aiui-code", "packages/aiui-dev-overlay/workbench"],
    // Source-first workspace deps: transform linked `@habemus-papadum/*` SOURCE
    // under test instead of externalizing it. Without this, a package that
    // imports another package's source (e.g. aiui-code-server →
    // aiui-code-protocol) hands its extensionless `.ts` relative imports to
    // Node's ESM resolver, which requires extensions and fails.
    server: { deps: { inline: [/@habemus-papadum\//] } },
  },
});
