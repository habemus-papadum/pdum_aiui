import { defineConfig } from "vitest/config";

// Aggregate every workspace package as a Vitest project; each package supplies its
// own vite.config.ts. `vitest run` at the root runs the whole monorepo at once.
// (aiui-code's config mode-gates its dev-harness plugins — the reader backend
// mounts under `vite dev`, never under Vitest's config evaluation.)
export default defineConfig({
  test: {
    projects: ["packages/*", "packages/aiui-dev-overlay/workbench"],
    // Source-first workspace deps: transform linked `@habemus-papadum/*` SOURCE
    // under test instead of externalizing it. Without this, a package that
    // imports another package's source (e.g. aiui-code-server →
    // aiui-code-protocol) hands its extensionless `.ts` relative imports to
    // Node's ESM resolver, which requires extensions and fails.
    server: { deps: { inline: [/@habemus-papadum\//] } },
  },
});
