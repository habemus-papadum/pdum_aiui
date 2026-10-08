import { defineConfig } from "vitest/config";

// Pure-math tests only (the engine is realm-free; the widgets are visually
// tested through the consuming demos). No aiui compiler pass needed: this
// package declares no cells/controls — it is playbook layer 1 plus imperative
// display islands.
export default defineConfig({
  // Vite 8 honours the tsconfig's `jsx: preserve`, and this plugin-less run
  // still loads .tsx (a graph test reaching a component module): compile it
  // with Solid's own jsx-runtime, never rendered by these tests. (The same
  // literal as SOLID_TEST_OXC in @habemus-papadum/aiui-build-config, which a
  // scaffolded app cannot import — this file mirrors the template's.)
  oxc: { jsx: { runtime: "automatic", importSource: "@solidjs/web" } },
  test: {
    environment: "node",
    passWithNoTests: true,
  },
});
