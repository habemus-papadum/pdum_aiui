import { defineConfig } from "vitest/config";

// Aggregate every workspace package as a Vitest project; each package supplies its
// own vite.config.ts. `vitest run` at the root runs the whole monorepo at once.
export default defineConfig({
  test: {
    // demos/* are workspace members too (moving the gallery out of packages/
    // silently dropped its suites from CI — this glob is why they run).
    projects: [
      // Vitest makes a project of EVERY directory a glob matches, config file or
      // not — so a plain `packages/*` also claims the `packages/internal` FOLDER
      // and sweeps its members' tests under this root config (no Solid transform:
      // every .tsx import fails to parse). A `!packages/internal` entry is no fix:
      // tinyglobby excludes the whole subtree, which silently drops the members'
      // suites. The extglob skips the folder and keeps the members below.
      "packages/!(internal)",
      "packages/internal/*",
      "packages/aiui-prompts/spikes/authoring",
      "packages/aiui-prompts/spikes/inspector",
      "demos/*",
    ],
    // Source-first workspace deps: transform linked `@habemus-papadum/*` SOURCE
    // under test instead of externalizing it. Without this, a package that
    // imports another package's source hands its extensionless `.ts` relative
    // imports to Node's ESM resolver, which requires extensions and fails.
    server: { deps: { inline: [/@habemus-papadum\//] } },
  },
});
