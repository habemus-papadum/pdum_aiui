// Minimal on purpose (pure TS, no DOM, no compiler pass) — but load-bearing:
// without a config here, `vitest` run from this directory walks up to the repo
// root's projects config (whose globs are CWD-relative and match nothing).
// This also serves as the package's project config under the root run.
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Vite 8 honours the tsconfig's `jsx: preserve`, and this plugin-less run
  // still loads .tsx (a graph test reaching a component module): compile it
  // with Solid's own jsx-runtime, never rendered by these tests. (The same
  // literal as SOLID_TEST_OXC in @habemus-papadum/aiui-build-config, which a
  // scaffolded app cannot import — this file mirrors the template's.)
  oxc: { jsx: { runtime: "automatic", importSource: "@solidjs/web" } },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
