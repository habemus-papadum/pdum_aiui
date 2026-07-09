import { configDefaults, defineConfig } from "vitest/config";

// The starter template ships example tests (rose.test.ts, scenery.test.ts)
// that run inside scaffolded apps and in-repo demos under the template's OWN
// vitest.config.ts (jsdom + the Solid resolution story). Under THIS package's
// project they'd run with none of that and fail on `window` — so template
// tests are excluded here and template *compilation* is guarded instead by
// `tsc -p tsconfig.template.json` (part of this package's typecheck script).
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "templates/**"],
  },
});
