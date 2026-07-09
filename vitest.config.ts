import { defineConfig } from "vitest/config";

// Aggregate every workspace package as a Vitest project; each package supplies its
// own vite.config.ts. `vitest run` at the root runs the whole monorepo at once.
export default defineConfig({
  test: {
    // demos/* are workspace members too (moving the gallery out of packages/
    // silently dropped its suites from CI — this glob is why they run).
    projects: ["packages/*", "demos/*"],
    // Source-first workspace deps: transform linked `@habemus-papadum/*` SOURCE
    // under test instead of externalizing it. Without this, a package that
    // imports another package's source hands its extensionless `.ts` relative
    // imports to Node's ESM resolver, which requires extensions and fails.
    server: { deps: { inline: [/@habemus-papadum\//] } },
  },
});
