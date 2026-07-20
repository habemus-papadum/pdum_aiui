// Local config so vitest does NOT walk up to the repo root's project-glob
// config — this package is standalone (see pnpm-workspace.yaml here).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
  },
});
