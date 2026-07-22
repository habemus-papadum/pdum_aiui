// Minimal on purpose (pure TS, no DOM, no compiler pass) — but load-bearing:
// without a config here, `vitest` run from this directory walks up to the repo
// root's projects config (whose globs are CWD-relative and match nothing).
// This also serves as the package's project config under the root run.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
